/**
 * Evidence archive on AWS S3 (optional).
 *
 * When AWS_S3_BUCKET plus credentials are configured, every evidence clip a customer uploads is
 * also written to S3 as `claims/<order_id>/<video_id>.<ext>` with the Memories.ai video id and
 * order id as object metadata. This is the durable, auditable copy of the evidence; Memories.ai
 * keeps the searchable derivatives. Without the env vars the archive is a no-op, so local and
 * demo runs need nothing from AWS.
 *
 * Env: AWS_S3_BUCKET (required to enable), AWS_REGION (default us-east-1),
 *      AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or the runtime's own credential chain),
 *      AWS_S3_ENDPOINT (optional: S3-compatible stores such as MinIO; forces path-style URLs),
 *      AWS_S3_PREFIX (default "claims").
 */
import { S3Client, PutObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createLogger } from './_logger';

const logger = createLogger('archive');

export interface ArchiveEnv {
  AWS_S3_BUCKET?: string;
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_S3_ENDPOINT?: string;
  AWS_S3_PREFIX?: string;
  [key: string]: string | undefined;
}

export interface ArchiveResult {
  archived: boolean;
  bucket?: string;
  key?: string;
  url?: string;
  reason?: string;
}

export function isArchiveEnabled(env: ArchiveEnv): boolean {
  return Boolean(env.AWS_S3_BUCKET && env.AWS_S3_BUCKET.trim());
}

let cached: { key: string; client: S3Client } | null = null;

function clientFor(env: ArchiveEnv): S3Client {
  const region = env.AWS_REGION?.trim() || 'us-east-1';
  const endpoint = env.AWS_S3_ENDPOINT?.trim() || undefined;
  const cacheKey = `${region}|${endpoint ?? ''}|${env.AWS_ACCESS_KEY_ID ?? ''}`;
  if (cached && cached.key === cacheKey) return cached.client;
  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }
      : {}),
  });
  cached = { key: cacheKey, client };
  return client;
}

function extensionOf(filename: string, mime: string): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(filename);
  if (m) return m[1].toLowerCase();
  if (/quicktime/.test(mime)) return 'mov';
  if (/webm/.test(mime)) return 'webm';
  return 'mp4';
}

/** Copy one evidence clip to the S3 archive. Never throws: archiving must not block the claim. */
export async function archiveEvidence(input: {
  env: ArchiveEnv;
  bytes: Uint8Array | Buffer;
  filename: string;
  mime: string;
  orderId: string;
  videoId: string;
  conversationId?: string;
}): Promise<ArchiveResult> {
  const { env } = input;
  if (!isArchiveEnabled(env)) return { archived: false, reason: 'AWS_S3_BUCKET not set' };
  const bucket = env.AWS_S3_BUCKET!.trim();
  const prefix = (env.AWS_S3_PREFIX?.trim() || 'claims').replace(/^\/+|\/+$/g, '');
  const key = `${prefix}/${input.orderId}/${input.videoId}.${extensionOf(input.filename, input.mime)}`;
  try {
    const client = clientFor(env);
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: input.bytes,
      ContentType: input.mime || 'video/mp4',
      Metadata: {
        'order-id': input.orderId,
        'video-id': input.videoId,
        ...(input.conversationId ? { 'conversation-id': input.conversationId } : {}),
        'archived-at': new Date().toISOString(),
      },
    }));
    const base = env.AWS_S3_ENDPOINT?.trim()
      ? `${env.AWS_S3_ENDPOINT.trim().replace(/\/+$/, '')}/${bucket}`
      : `https://${bucket}.s3.${env.AWS_REGION?.trim() || 'us-east-1'}.amazonaws.com`;
    const url = `${base}/${key}`;
    logger.log(`[archive] s3://${bucket}/${key} (${input.bytes.byteLength} bytes)`);
    return { archived: true, bucket, key, url };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('[archive] upload failed (claim continues without the archive copy):', message);
    return { archived: false, bucket, key, reason: message };
  }
}

/** Cheap readiness probe for /stats and the stage checklist. */
export async function archiveHealth(env: ArchiveEnv): Promise<{ enabled: boolean; reachable?: boolean; bucket?: string; error?: string }> {
  if (!isArchiveEnabled(env)) return { enabled: false };
  const bucket = env.AWS_S3_BUCKET!.trim();
  try {
    await clientFor(env).send(new HeadBucketCommand({ Bucket: bucket }));
    return { enabled: true, reachable: true, bucket };
  } catch (e) {
    return { enabled: true, reachable: false, bucket, error: e instanceof Error ? e.message : String(e) };
  }
}
