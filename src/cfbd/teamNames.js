// Maps CFBD school names to our tickers. Most CFBD names equal teams.name;
// ALIASES covers known spelling variants across API versions and years.

const ALIASES = {
  "appalachian state": "APP",
  connecticut: "CONN",
  "florida intl": "FIU",
  fiu: "FIU",
  hawaii: "HAW",
  "louisiana lafayette": "LA",
  "louisiana-lafayette": "LA",
  "louisiana monroe": "ULM",
  "louisiana-monroe": "ULM",
  "miami (fl)": "MIA",
  "miami (oh)": "MIAOH",
  "miami ohio": "MIAOH",
  mississippi: "OLE",
  "north carolina state": "NCST",
  "sam houston state": "SHSU",
  "san jose state": "SJSU",
  "southern mississippi": "USM",
  umass: "UMASS",
  "texas a & m": "TAMU",
  "sacramento st": "SACST",
  "north dakota st": "NDSU",
};

export function normalizeName(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents (San José -> San Jose)
    .replace(/[‘’'`]/g, "") // Hawai'i -> Hawaii
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// teams: [{id, name}] -> (cfbdName) => ticker | null
export function createTeamResolver(teams) {
  const byName = new Map(Object.entries(ALIASES));
  for (const t of teams) byName.set(normalizeName(t.name), t.id);
  return (cfbdName) => (cfbdName ? byName.get(normalizeName(cfbdName)) ?? null : null);
}
