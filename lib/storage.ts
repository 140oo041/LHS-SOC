import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isLocalDevelopment } from "@/lib/config";

const localRoot = process.env.ATLAS_LOCAL_UPLOAD_DIR ?? "/tmp/atlas-uploads";

function s3Configured() {
  return Boolean(process.env.S3_BUCKET && process.env.S3_REGION);
}

let testClient: S3Client | null = null;

/** Lets tests substitute a stub client; never used by application code. */
export function setS3ClientForTests(client: S3Client | null) {
  testClient = client;
}

function s3() {
  if (testClient) return testClient;
  return new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
    // Newer SDKs add CRC checksums to every upload by default. A presigned
    // URL would then demand a checksum header the browser never sends, and
    // S3-compatible stores such as R2 reject some of them outright.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
}

// R2 encrypts everything at rest and rejects the AES256 header, so asking
// for server-side encryption is opt-in for stores that need it, such as S3.
function serverSideEncryption() {
  return process.env.S3_SSE === "AES256" ? ({ ServerSideEncryption: "AES256" } as const) : {};
}

function localPath(key: string) {
  const target = path.join(/* turbopackIgnore: true */ localRoot, key);
  if (!target.startsWith(`${localRoot}${path.sep}`)) throw new Error("Invalid storage key");
  return target;
}

export async function putObject(key: string, bytes: Uint8Array, contentType: string) {
  if (s3Configured()) {
    await s3().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ...serverSideEncryption(),
      }),
    );
    return;
  }
  // The local-disk fallback is for a developer's machine only. On a host it
  // would accept an upload, write it to a container filesystem that is
  // discarded on the next deploy, and report success.
  if (!isLocalDevelopment()) throw new Error("S3-compatible document storage is not configured");
  const target = localPath(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

export async function getObject(key: string): Promise<Uint8Array> {
  if (s3Configured()) {
    const result = await s3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    if (!result.Body) throw new Error("Stored document has no body");
    return result.Body.transformToByteArray();
  }
  return readFile(localPath(key));
}

/** Size and type of a stored object, or null when there is nothing there. */
export async function headObject(key: string): Promise<{ byteSize: number; contentType?: string } | null> {
  if (s3Configured()) {
    try {
      const result = await s3().send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
      return { byteSize: Number(result.ContentLength ?? 0), contentType: result.ContentType };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }
  try {
    return { byteSize: (await stat(localPath(key))).size };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string) {
  if (s3Configured()) {
    await s3().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return;
  }
  await rm(localPath(key), { force: true });
}

export type UploadTarget = { url: string; method: "PUT"; headers: Record<string, string> };

/**
 * Where the browser should send a file's bytes.
 *
 * With object storage that is a short-lived presigned URL straight to the
 * bucket, which keeps large files out of the serverless request-body limit.
 * Locally it is an Atlas route that writes to disk.
 */
export async function createUploadTarget(key: string, contentType: string, localUrl: string): Promise<UploadTarget> {
  if (!s3Configured()) return { url: localUrl, method: "PUT", headers: { "Content-Type": contentType } };
  const sse = serverSideEncryption();
  const url = await getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, ContentType: contentType, ...sse }),
    { expiresIn: 10 * 60 },
  );
  return {
    url,
    method: "PUT",
    headers: { "Content-Type": contentType, ...("ServerSideEncryption" in sse ? { "x-amz-server-side-encryption": "AES256" } : {}) },
  };
}

/** A one-minute download link, or null when files are served by Atlas itself. */
export async function createDownloadUrl(key: string, filename: string, contentType: string): Promise<string | null> {
  if (!s3Configured()) return null;
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ResponseContentType: contentType,
      ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    }),
    { expiresIn: 60 },
  );
}
