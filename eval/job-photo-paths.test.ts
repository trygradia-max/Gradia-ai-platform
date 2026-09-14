import { it, expect } from "vitest"
import { isOwnedJobPhotoPath } from "@/lib/job-photo-paths"
const name = "before-12345678-1234-4234-9234-123456789abc.jpg"
it("accepts only the owned appointment and phase's canonical object path", () => {
  expect(isOwnedJobPhotoPath(`aaaaaaaa-1234-4234-9234-123456789abc/bbbbbbbb-1234-4234-9234-123456789abc/${name}`,"aaaaaaaa-1234-4234-9234-123456789abc","bbbbbbbb-1234-4234-9234-123456789abc","before")).toBe(true)
  for (const path of [`other/job/${name}`,`shop/other/${name}`,`shop/job2/${name}`,`aaaaaaaa-1234-4234-9234-123456789abc/bbbbbbbb-1234-4234-9234-123456789abc/../${name}`,`aaaaaaaa-1234-4234-9234-123456789abc/bbbbbbbb-1234-4234-9234-123456789abc/%2e%2e/${name}`,`aaaaaaaa-1234-4234-9234-123456789abc/bbbbbbbb-1234-4234-9234-123456789abc/${name}?x=1`,`https://x/aaaaaaaa-1234-4234-9234-123456789abc/bbbbbbbb-1234-4234-9234-123456789abc/${name}`,`aaaaaaaa-1234-4234-9234-123456789abc/bbbbbbbb-1234-4234-9234-123456789abc/after-${name}`,`aaaaaaaa-1234-4234-9234-123456789abc/bbbbbbbb-1234-4234-9234-123456789abc/${name}%2f`, null]) expect(isOwnedJobPhotoPath(path,"aaaaaaaa-1234-4234-9234-123456789abc","bbbbbbbb-1234-4234-9234-123456789abc","before")).toBe(false)
})
