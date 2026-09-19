# AWS in ClaimSight

Two optional pieces, both off until configured:

1. **Evidence archive (S3).** Every uploaded clip is copied to `s3://<bucket>/claims/<order_id>/<video_id>.mp4` with the order and Memories.ai video id as object metadata (`cloud-functions/_archive.ts`). Memories.ai keeps the searchable derivatives; S3 keeps the durable original for audits and chargebacks. Enable with:
   ```
   AWS_S3_BUCKET=claimsight-evidence-…   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=…                   AWS_SECRET_ACCESS_KEY=…
   # S3-compatible stores (MinIO, R2): AWS_S3_ENDPOINT=http://localhost:9000
   ```
2. **Production host (EC2).** The same host runs the Blender render worker (`scripts/render-service.ts` on :8090) that produces Damage Twin receipts and the Synthetic Evidence Lab clips, so rendering never touches the Makers functions.
   Original note: `claimsight-infra.yaml` creates the bucket, an IAM role scoped to it, and one small instance whose user data (`ec2-user-data.sh`) installs the AgentX self-hosted engine as a systemd service and a MediaMTX relay so Memories.ai can pull a live evidence stream from a phone (Memories.ai streams are pull-only).
   ```bash
   aws cloudformation deploy --stack-name claimsight --template-file aws/claimsight-infra.yaml \
     --capabilities CAPABILITY_IAM --parameter-overrides KeyName=<your-key> AdminCidr=<your-ip>/32
   ```
   Then point the app at it: `AGENTX_OTLP_URL=http://<ip>:4700/api/v1/otel/v1/traces`, and for live evidence `open_stream` with `rtsp://<ip>:8554/live/cam`.

The hackathon's AWS credits fund exactly these two things for the first pilot: video volume in S3 and the always-on governance host.
