/**
 * Smoke test for the S3 evidence archive (cloud-functions/_archive.ts).
 *
 *   AWS_S3_BUCKET=… AWS_REGION=… AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… npx tsx scripts/archive-smoke.ts
 *   # S3-compatible (MinIO): add AWS_S3_ENDPOINT=http://localhost:9000  (the bucket is created if missing)
 *
 * Uploads assets/test-clips/mug_chipped.mp4 as order A1042 / video smoke-<ts>, then HEADs the object back.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, CreateBucketCommand, HeadBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { archiveEvidence, archiveHealth } from '../cloud-functions/_archive';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env as Record<string, string | undefined>;

async function main(): Promise<void> {
  if (!env.AWS_S3_BUCKET) { console.error('AWS_S3_BUCKET is not set'); process.exit(2); }
  const client = new S3Client({
    region: env.AWS_REGION || 'us-east-1',
    ...(env.AWS_S3_ENDPOINT ? { endpoint: env.AWS_S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } } : {}),
  });
  try { await client.send(new HeadBucketCommand({ Bucket: env.AWS_S3_BUCKET })); }
  catch { console.log(`bucket ${env.AWS_S3_BUCKET} missing → creating`); await client.send(new CreateBucketCommand({ Bucket: env.AWS_S3_BUCKET })); }

  const health = await archiveHealth(env);
  console.log('health:', JSON.stringify(health));
  const file = path.join(ROOT, 'assets', 'test-clips', 'mug_chipped.mp4');
  const bytes = await fs.readFile(file);
  const videoId = `smoke-${Date.now()}`;
  const result = await archiveEvidence({ env, bytes, filename: 'mug_chipped.mp4', mime: 'video/mp4', orderId: 'A1042', videoId, conversationId: 'smoke' });
  console.log('archive:', JSON.stringify(result));
  if (!result.archived || !result.key) process.exit(1);
  const head = await client.send(new HeadObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: result.key }));
  console.log(`verified: s3://${env.AWS_S3_BUCKET}/${result.key} ${head.ContentLength} bytes, metadata=${JSON.stringify(head.Metadata)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
