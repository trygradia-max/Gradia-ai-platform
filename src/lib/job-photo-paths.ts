export const isCanonicalPhotoId = (value: unknown): value is string => typeof value === "string" && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
/** Only canonical paths generated for this owned appointment may be signed.
 * Reject encoded separators, traversal, URLs and other appointment prefixes. */
export function isOwnedJobPhotoPath(path: unknown, shopId: string, appointmentId: string, phase: "before" | "after"): path is string {
  if ((phase !== "before" && phase !== "after") || typeof path !== "string" || /\s/.test(path)) return false
  if (!isCanonicalPhotoId(shopId) || !isCanonicalPhotoId(appointmentId)) return false
  const parts = path.split("/")
  if (parts.length !== 3 || parts[0] !== shopId || parts[1] !== appointmentId) return false
  return new RegExp(`^${phase}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:jpg|jpeg|png|webp|heic|heif)$`).test(parts[2])
}
