import type { PublicCase } from "./cases";

// Public half of Case 002. The suspects' private briefs and the answer live in
// server/cases/case002.ts and never reach the browser.
export const CASE_002: PublicCase = {
  id: "002",
  title: "The Vienna Pads",
  teaser:
    "Someone opened the Vienna station's safe at 22:08 and photographed the cipher pads.",
  questionLimit: 12,
  brief: [
    "At 07:30 this morning, the Vienna station found its one-time pads out of order in the safe. The safe log shows it was opened at 22:08 last night with the station code. By midnight, the opposition had stopped using the radio channel those pads were made to read.",
    "The station is a flat above a piano shop in Neubau. The station code opens both the yard door and the safe. After 21:00 the building was meant to be empty except for the duty officer downstairs.",
  ],
  intercept:
    "Pages photographed and received 22:31. Our friend came and went by the yard door. The opera story will hold.",
  interceptTime: "23:02",
  orders:
    "Five officers know the station code. One of them works for the other side. You have 12 questions across all five. Spend them, then name the mole. You get one accusation.",
  suspects: [
    {
      id: "falcon",
      codename: "FALCON",
      name: "Lena Hartmann",
      role: "Head of station, 19 years",
      lastNight: "Left the station at 20:30.",
      onFile: "Phone switched off from 21:30 to 23:15.",
    },
    {
      id: "wren",
      codename: "WREN",
      name: "Jonas Keller",
      role: "Duty officer, 3 years",
      lastNight: "Alone on duty in the ground-floor radio room.",
      onFile: "Missed the 21:45 radio check-in.",
    },
    {
      id: "otter",
      codename: "OTTER",
      name: "Mira Novak",
      role: "Driver, 7 years",
      lastNight:
        "On car standby from 19:00. Told the duty desk she waited at the Westbahnhof taxi rank.",
      onFile:
        "Car tracker: parked on the Ring by the Staatsoper, 19:20 to 22:30.",
    },
    {
      id: "marten",
      codename: "MARTEN",
      name: "Felix Brandt",
      role: "Cipher clerk, 11 years",
      lastNight: "Left the station at 18:30.",
      onFile: "Holds a private key to the yard door.",
    },
    {
      id: "ibis",
      codename: "IBIS",
      name: "Daniel Reyes",
      role: "Analyst, 5 years",
      lastNight: "Off duty from 18:00.",
      onFile: "Expenses claim: taxi from the Ring, 21:58.",
    },
  ],
};
