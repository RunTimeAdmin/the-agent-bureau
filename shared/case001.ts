import type { PublicCase } from "./cases";

// Public half of Case 001: what the player sees before naming the mole. The
// suspects' private briefs and the answer live in server/cases/case001.ts and
// never reach the browser.

export const suspectIds = ["kestrel", "moth", "heron", "lynx", "vane"];

export const CASE_001: PublicCase = {
  id: "001",
  title: "The Lisbon Leak",
  teaser: "A courier's route was sold the night before a run out of Lisbon.",
  questionLimit: 12,
  brief: [
    "At 06:10 this morning, the courier SPARROW boarded the Porto train at Santa Apolónia with the Lisbon ledger. Two opposition watchers were already sitting in carriage 7, SPARROW's carriage. SPARROW slipped off at Oriente. The courier and the ledger are safe. The route is not.",
    "The run was planned at a 21:00 briefing in the Graça safehouse, for the 07:40 train. Late last night it was moved to the 06:10.",
  ],
  intercept:
    "Courier boards 06:10, platform 3, carriage 7. Received from our friend at 23:30, at the viewpoint.",
  interceptTime: "23:41",
  orders:
    "Five officers sat in that briefing. One of them works for the other side. You have 12 questions across all five. Spend them, then name the mole. You get one accusation.",
  suspects: [
    {
      id: "kestrel",
      codename: "KESTREL",
      name: "Margarida Sá",
      role: "Station chief, 22 years",
      lastNight: "Ran the briefing. Stayed at the safehouse.",
      onFile:
        "Phone log: 23:00, personal phone, 18-minute call to a London number.",
    },
    {
      id: "moth",
      codename: "MOTH",
      name: "Tomás Vieira",
      role: "Signals officer, 6 years",
      lastNight: "On duty in the safehouse signals room.",
      onFile: "Terminal log: messages deleted at 23:45.",
    },
    {
      id: "heron",
      codename: "HERON",
      name: "Inês Duarte",
      role: "Driver, 4 years",
      lastNight:
        "Left the briefing at 22:05. Drove SPARROW to the station at 05:20.",
      onFile: "Told the duty desk she was home in Belém all night.",
    },
    {
      id: "lynx",
      codename: "LYNX",
      name: "Owen Price",
      role: "Analyst on loan from London, 3 days in Lisbon",
      lastNight: "Left the briefing at 22:00.",
      onFile: "Asked for a copy of the courier schedule on Monday.",
    },
    {
      id: "vane",
      codename: "VANE",
      name: "Rui Antunes",
      role: "Quartermaster, 9 years",
      lastNight: "Rebooked the tickets after the change.",
      onFile: "Transit card: Tram 28, 23:04.",
    },
  ],
};
