import { it, expect } from "vitest"
import { isOwnedJobPhotoPath } from "@/lib/job-photo-paths"
const name = "before-12345678-1234-4234-9234-123456789abc.jpg"
it("accepts only the owned appointment and phase's canonical object path", () => {
  expect(isOwnedJobPhotoPath(`shop/job/${name}`,"shop","job","before")).toBe(true)
  for (const path of [`other/job/${name}`,`shop/other/${name}`,`shop/job2/${name}`,`shop/job/../${name}`,`shop/job/%2e%2e/${name}`,`shop/job/${name}?x=1`,`https://x/shop/job/${name}`,`shop/job/after-${name}`,`shop/job/${name}%2f`, null]) expect(isOwnedJobPhotoPath(path,"shop","job","before")).toBe(false)
})
