import type { Document, ProjectAsset } from "@/lib/api";
import type { AssetMeta } from "@/pages/workspace/types";

export function mapDocumentsByPath(documents: Document[]) {
  const output: Record<string, string> = {};
  for (const doc of documents) {
    output[doc.path] = doc.content;
  }
  return output;
}

export function mapAssetMetaByPath(assets: ProjectAsset[]) {
  const output: Record<string, AssetMeta> = {};
  for (const asset of assets) {
    output[asset.path] = {
      id: asset.id,
      objectKey: asset.object_key,
      contentType: asset.content_type,
      sizeBytes: asset.size_bytes,
      createdAt: asset.created_at
    };
  }
  return output;
}
