import {it,expect} from "vitest"
import {normalizeDestination} from "@/lib/contact-destination"
it("uses conservative ASCII email and international phone canonicalization",()=>{
 for(const value of ["SAM@EXAMPLE.TEST"," sam@example.test ","\tSam@example.test\r\n"]) expect(normalizeDestination("email",value)).toBe("sam@example.test")
 for(const value of ["+15551112222"," +1 (555) 111-2222 "]) expect(normalizeDestination("sms",value)).toBe("+15551112222")
 for(const value of ["5551112222","+0123456789","+1/5551112222","+1555@example.test"]) expect(normalizeDestination("sms",value)).toBeNull()
 for(const value of ["sam@example.test,other@example.test","sam @example.test","säm@example.test"]) expect(normalizeDestination("email",value)).toBeNull()
})

it("does not turn national-only import numbers into a contactable identity",()=>{
 expect(normalizeDestination("sms","415-555-0177")).toBeNull()
 expect(normalizeDestination("sms","+1 415-555-0177")).toBe("+14155550177")
})
