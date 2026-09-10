/** Exact normalization only: never guess country codes or email aliases. */
export function normalizeDestination(channel: "sms" | "email", raw: string): string | null {
    if (typeof raw !== "string")
        return null;
    if (channel === "email") {
        const value = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
        if (!/^[!-~]+$/.test(value))
            return null;
        const email = value.toLowerCase();
        return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email) ? email : null;
    }
    if (!/^\+[\d ().-]+$/.test(raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "")))
        return null;
    const phone = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").replace(/[ ().-]/g, "");
    return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : null;
}
