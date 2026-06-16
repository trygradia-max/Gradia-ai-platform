/**
 * Vehicle parser — turns free-text car_info ("2021 Tesla Model 3, ceramic")
 * into structured make/model/year for segmentation. Mirrors the SQL backfill in
 * 20260615130000_structured_segments.sql so new captures stay consistent with
 * backfilled rows. Best-effort: returns nulls for anything it can't read.
 *
 * Make uses word-boundary matching so "ram" doesn't match "ceramic".
 */

export type ParsedVehicle = {
  make: string | null
  model: string | null
  year: number | null
  color: string | null
}

const COLORS: Array<[RegExp, string]> = [
  [/\bblack\b/i, "Black"],
  [/\bwhite\b/i, "White"],
  [/\b(silver|grey|gray)\b/i, "Silver"],
  [/\bred\b/i, "Red"],
  [/\bblue\b/i, "Blue"],
  [/\bgreen\b/i, "Green"],
  [/\bbrown\b/i, "Brown"],
  [/\b(gold|beige|tan)\b/i, "Tan"],
  [/\byellow\b/i, "Yellow"],
  [/\borange\b/i, "Orange"],
  [/\bpurple\b/i, "Purple"],
]

const MAKES: Array<[RegExp, string]> = [
  [/\btesla\b/i, "Tesla"],
  [/\btoyota\b/i, "Toyota"],
  [/\bhonda\b/i, "Honda"],
  [/\bford\b/i, "Ford"],
  [/\b(chevrolet|chevy)\b/i, "Chevrolet"],
  [/\bbmw\b/i, "BMW"],
  [/\b(mercedes|benz)\b/i, "Mercedes-Benz"],
  [/\baudi\b/i, "Audi"],
  [/\blexus\b/i, "Lexus"],
  [/\bnissan\b/i, "Nissan"],
  [/\bjeep\b/i, "Jeep"],
  [/\bdodge\b/i, "Dodge"],
  [/\bram\b/i, "Ram"],
  [/\bgmc\b/i, "GMC"],
  [/\bsubaru\b/i, "Subaru"],
  [/\bhyundai\b/i, "Hyundai"],
  [/\bkia\b/i, "Kia"],
  [/\bporsche\b/i, "Porsche"],
  [/\bmazda\b/i, "Mazda"],
  [/\b(volkswagen|vw)\b/i, "Volkswagen"],
  [/\bcadillac\b/i, "Cadillac"],
  [/\bacura\b/i, "Acura"],
  [/\binfiniti\b/i, "Infiniti"],
  [/\bvolvo\b/i, "Volvo"],
  [/\b(land rover|range rover)\b/i, "Land Rover"],
  [/\bjaguar\b/i, "Jaguar"],
  [/\bchrysler\b/i, "Chrysler"],
  [/\bbuick\b/i, "Buick"],
  [/\blincoln\b/i, "Lincoln"],
  [/\bgenesis\b/i, "Genesis"],
  [/\bmini\b/i, "Mini"],
  [/\brivian\b/i, "Rivian"],
  [/\blucid\b/i, "Lucid"],
  [/\bferrari\b/i, "Ferrari"],
  [/\blamborghini\b/i, "Lamborghini"],
  [/\bmaserati\b/i, "Maserati"],
  [/\bbentley\b/i, "Bentley"],
]

export function parseVehicle(carInfo: string | null | undefined): ParsedVehicle {
  if (!carInfo) return { make: null, model: null, year: null, color: null }
  const text = carInfo.trim()
  if (!text) return { make: null, model: null, year: null, color: null }

  let color: string | null = null
  for (const [re, name] of COLORS) {
    if (re.test(text)) {
      color = name
      break
    }
  }

  let make: string | null = null
  let makeMatch: RegExpMatchArray | null = null
  for (const [re, name] of MAKES) {
    const m = text.match(re)
    if (m) {
      make = name
      makeMatch = m
      break
    }
  }

  const yearMatch = text.match(/\b(?:19|20)\d{2}\b/)
  const year = yearMatch ? Number.parseInt(yearMatch[0], 10) : null

  // Model: the first 1–2 word-ish tokens right after the make, minus the year.
  let model: string | null = null
  if (make && makeMatch?.index != null) {
    const after = text
      .slice(makeMatch.index + makeMatch[0].length)
      .replace(/\b(?:19|20)\d{2}\b/g, "")
      .replace(/[,.;].*$/, "") // stop at punctuation (drops "ceramic" etc.)
      .trim()
    const tokens = after.split(/\s+/).filter(Boolean).slice(0, 2)
    if (tokens.length) model = tokens.join(" ")
  }

  return { make, model, year, color }
}
