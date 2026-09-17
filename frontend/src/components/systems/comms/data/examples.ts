import type { Person } from "../../access/domain/model";
import {
  OPEN_PERMISSIONS,
  type Category,
  type Channel,
  type Direct,
  type Message,
  type Thread,
} from "../domain/model";

// Fictional examples use fixed dates and stable IDs so saved conversations can be enriched once.
export const EXAMPLE_PEOPLE: Person[] = [
  ["Sofia Garcia", "Customer service", "Customer success lead"],
  ["Noah Tan", "Operations", "Fleet coordinator"],
  ["Isabel Lim", "Finance", "Finance lead"],
  ["Leo Mendoza", "Operations", "Workshop technician"],
  ["Amara Flores", "Commercial", "Account manager"],
  ["Theo Ramos", "Operations", "Field engineer"],
  ["Camille Dizon", "Customer service", "Service coordinator"],
  ["Gabriel Ong", "Commercial", "Partnerships specialist"],
  ["Lena Navarro", "Operations", "Quality coordinator"],
  ["Rafael Castillo", "Operations", "Inventory specialist"],
  ["Chloe Bautista", "Finance", "Billing specialist"],
  ["Marco Villanueva", "Commercial", "Product specialist"],
  ["Ava Chen", "Customer service", "Support specialist"],
  ["Daniel Aquino", "Operations", "Safety coordinator"],
  ["Mika Soriano", "Commercial", "Communications specialist"],
  ["Sam Rivera", "Operations", "Service planner"],
  ["Bea Mercado", "Finance", "Procurement analyst"],
  ["Oliver Sy", "Customer service", "Onboarding specialist"],
].map(([name, department, title]) => ({
  id: `sample-person-${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  email: `${name.toLowerCase().replaceAll(" ", ".")}@example.invalid`,
  role: "sample-member",
  active: true,
  departments: [department],
  primary: department,
  title,
  activity: ["Joined the team"],
}));

export const EXAMPLE_CATEGORIES: Category[] = [
  {
    id: "sample-category-service",
    name: "Service delivery",
    ...OPEN_PERMISSIONS,
  },
  {
    id: "sample-category-growth",
    name: "Customer & growth",
    ...OPEN_PERMISSIONS,
  },
  { id: "sample-category-team", name: "Team spaces", ...OPEN_PERMISSIONS },
];
export const EXAMPLE_CHANNELS: Channel[] = [
  [
    "announcements",
    "company",
    "Company updates, important dates, and decisions worth keeping.",
  ],
  [
    "team-wins",
    "sample-category-team",
    "Small victories and people who made a difference.",
  ],
  [
    "dispatch",
    "sample-category-service",
    "Routes, arrival windows, and field team handovers.",
  ],
  [
    "customers",
    "sample-category-growth",
    "Customer questions, feedback, and clear next steps.",
  ],
  [
    "field-notes",
    "sample-category-service",
    "Practical observations from visits and inspections.",
  ],
  ["product-launch", "projects", "Preparing our preventive maintenance pilot."],
  [
    "parts-and-stock",
    "sample-category-service",
    "Parts availability, incoming deliveries, and supplies.",
  ],
  [
    "finance-desk",
    "sample-category-growth",
    "Billing questions and purchase request coordination.",
  ],
  [
    "coffee-corner",
    "sample-category-team",
    "A little breathing room between busy parts of the day.",
  ],
  [
    "learning-lab",
    "projects",
    "Show-and-tells, useful checklists, and lessons to reuse.",
  ],
].map(([name, categoryId, description]) => ({
  id: `sample-channel-${name}`,
  name,
  categoryId,
  description,
  inherit: name !== "announcements",
  archived: false,
  system: false,
  ...OPEN_PERMISSIONS,
  ...(name === "announcements"
    ? { posting: "roles" as const, postRoles: ["sample-admin"] }
    : {}),
}));

function authorId(name: string): string {
  if (name === "Eli Cruz") return "sample-eli";
  if (name === "Mara Santos") return "sample-mara";
  return `sample-person-${name.toLowerCase().replaceAll(" ", "-")}`;
}
type Entry = [
  author: string,
  text: string,
  extra?: Partial<
    Pick<
      Message,
      "pinned" | "reactions" | "recordId" | "attachment" | "replyToId"
    >
  >,
];
function conversation(name: string, entries: Entry[], day = 11): Message[] {
  return entries.map(([author, text, extra], index) => ({
    id: `sample-example-${name}-${index + 1}`,
    conversation: name.startsWith("dm-")
      ? `sample-${name}`
      : `sample-channel-${name}`,
    author,
    authorId: authorId(author),
    text,
    created: Date.UTC(2026, 8, day, 1, index * 19),
    pinned: false,
    ...extra,
  }));
}
export const EXAMPLE_MESSAGES: Message[] = [
  ...conversation("operations", [
    [
      "Eli Cruz",
      "**Friday handover**\nDispatch is covering morning visits. Workshop will post a pump update before lunch.",
      { pinned: true },
    ],
    [
      "Noah Tan",
      "Two vans are loaded. The spare tool kit is in the blue crate beside dispatch.",
    ],
    [
      "Sofia Garcia",
      "Riverside asked for a clear next update time. Can we confirm one before I call back?",
      { recordId: "sample-sr-1004" },
    ],
    [
      "Morgan Kim",
      "Yes—11:30 works. We are checking the replacement seal fit now.",
      { replyToId: "sample-example-operations-3" },
    ],
    [
      "Daniel Aquino",
      "Check the site induction requirements before leaving. The visitor form changed this week.",
    ],
    [
      "Mara Santos",
      "Thanks for keeping the handover specific. An owner and a next update time make a huge difference.",
      {
        reactions: {
          "👍": [
            "sample-eli",
            "sample-person-sofia-garcia",
            "sample-person-noah-tan",
          ],
        },
      },
    ],
    [
      "Sam Rivera",
      "Afternoon coverage is set: Theo on site, Camille on customer updates, Eli on dispatch.",
    ],
    [
      "Jamie Torres",
      "I can cover the 2 pm callback if the field visit runs over.",
    ],
    [
      "Eli Cruz",
      "That helps, Jamie. I have added the backup owner to the handover notes.",
    ],
    [
      "Sofia Garcia",
      "Riverside has the update and is happy with the plan. Next callback is after the workshop check.",
    ],
    [
      "Alex Lee",
      "Morning visits are wrapped up. One follow-up question is in field-notes; nothing blocking dispatch.",
    ],
    [
      "Mara Santos",
      "Good handover, everyone. Leave afternoon changes here so the next shift has the full picture.",
    ],
  ]),
  ...conversation("workshop", [
    [
      "Leo Mendoza",
      "The replacement seal is on the bench. I am checking the kit contents against the job notes.",
    ],
    [
      "Morgan Kim",
      "Please keep the old seal labelled until the inspection is complete.",
      { recordId: "sample-sr-1004" },
    ],
    [
      "Lena Navarro",
      "I will review the inspection notes before we close the bench check.",
    ],
    [
      "Rafael Castillo",
      "The matching gasket is available. I have reserved one kit for this job.",
    ],
    [
      "Leo Mendoza",
      "Kit contents match. Packaging is intact and the batch label is readable.",
      {
        reactions: {
          "✅": ["sample-person-morgan-kim", "sample-person-lena-navarro"],
        },
      },
    ],
    [
      "Morgan Kim",
      "**Bench check complete**\nFit confirmed. Final observations are recorded; the customer update can go ahead.",
      { recordId: "sample-sr-1004" },
    ],
    [
      "Pat Riley",
      "I have cleared the second bench for the afternoon inspection.",
    ],
    [
      "Drew Shaw",
      "Thanks, Pat. I will return the labelled tools before the next team comes in.",
    ],
  ]),
  ...conversation(
    "announcements",
    [
      [
        "Mara Santos",
        "**Welcome to the team space**\nUse operations for daily coordination, dispatch for visit changes, and customers for follow-ups.",
        {
          pinned: true,
          reactions: { "👍": ["sample-eli", "sample-person-sofia-garcia"] },
        },
      ],
      [
        "Mara Santos",
        "Friday catch-up is at 3 pm. Bring one useful lesson and one question we can solve together.",
      ],
      [
        "Mara Santos",
        "The preventive maintenance pilot is taking shape. Product-launch has the scope and readiness discussion.",
      ],
      [
        "Mara Santos",
        "Keep customer details in the relevant record. A short summary and a record link are enough for shared channels.",
      ],
      [
        "Mara Santos",
        "New starters: Oliver can help you find the right channel and Lena can explain the service checklist.",
      ],
      [
        "Mara Santos",
        "Thank you for this week’s thoughtful handovers. We will keep the owner + next update format next week.",
        {
          reactions: {
            "❤️": [
              "sample-person-camille-dizon",
              "sample-person-amara-flores",
              "sample-eli",
            ],
          },
        },
      ],
    ],
    10,
  ),
  ...conversation("team-wins", [
    [
      "Sofia Garcia",
      "A customer told us they never had to chase for an update this week. That is a win worth celebrating.",
      {
        reactions: {
          "🎉": ["sample-mara", "sample-eli", "sample-person-camille-dizon"],
        },
      },
    ],
    [
      "Camille Dizon",
      "Credit to the field team for sharing arrival windows early. It made every callback easier.",
    ],
    [
      "Theo Ramos",
      "And credit to Camille for catching the access requirement before we left!",
    ],
    [
      "Isabel Lim",
      "Purchase requests arrived with the job reference and owner filled in. No follow-up emails needed today.",
    ],
    [
      "Rafael Castillo",
      "The small-parts shelf finally has labels you can read from a normal distance.",
    ],
    [
      "Leo Mendoza",
      "Tested from the other side of the workshop. Can confirm. 😄",
      {
        replyToId: "sample-example-team-wins-5",
        reactions: {
          "😂": ["sample-person-rafael-castillo", "sample-person-pat-riley"],
        },
      },
    ],
    [
      "Mara Santos",
      "These are the improvements that give us time back. Keep them coming.",
    ],
  ]),
  ...conversation("dispatch", [
    [
      "Noah Tan",
      "**Morning dispatch**\nVan 1: Theo + Alex\nVan 2: Jamie + Pat\nEli is coordinating route changes.",
      { pinned: true },
    ],
    [
      "Eli Cruz",
      "Post departure and arrival updates here. Customer callbacks stay with Camille.",
    ],
    [
      "Theo Ramos",
      "Van 1 has departed. Tool checklist complete; no missing items.",
    ],
    [
      "Jamie Torres",
      "Van 2 is waiting on visitor confirmation. We can leave as soon as it lands.",
    ],
    [
      "Camille Dizon",
      "Visitor confirmation received. The site contact expects you at main reception.",
    ],
    [
      "Pat Riley",
      "Received, thank you. We are leaving now.",
      { replyToId: "sample-example-dispatch-5" },
    ],
    [
      "Alex Lee",
      "Van 1 is on site. I will post again after the initial walkthrough.",
    ],
    [
      "Sam Rivera",
      "The afternoon buffer is still open. Let me know before assigning another visit into it.",
    ],
    [
      "Noah Tan",
      "Both morning visits are accounted for. Keys and fuel cards back to the desk at handover.",
    ],
  ]),
  ...conversation("customers", [
    [
      "Sofia Garcia",
      "Riverside needs a plain-language summary of the pump work. Let’s keep the next update short and specific.",
      { recordId: "sample-sr-1004" },
    ],
    [
      "Ava Chen",
      "Draft: We have checked the replacement parts and will confirm the next step after the workshop inspection.",
    ],
    [
      "Morgan Kim",
      "That is accurate. Avoid saying the repair is complete while the job is still in progress.",
    ],
    [
      "Camille Dizon",
      "Updated the wording. I have also included the next callback time.",
    ],
    [
      "Amara Flores",
      "A useful pattern for other accounts too: what changed, what happens next, and who will call.",
    ],
    ["Oliver Sy", "I am adding that pattern to the onboarding examples."],
    [
      "Sofia Garcia",
      "Callback done. Riverside understands the next step; no further questions for now.",
      {
        reactions: {
          "👍": ["sample-person-ava-chen", "sample-person-morgan-kim"],
        },
      },
    ],
    [
      "Ava Chen",
      "I will cover the shared inbox during the afternoon catch-up.",
    ],
  ]),
  ...conversation("field-notes", [
    [
      "Theo Ramos",
      "Site note: the loading entrance and visitor entrance are on different sides. Allow time for the walk.",
    ],
    [
      "Alex Lee",
      "Add the entrance detail to the visit notes so the next technician sees it before travelling.",
    ],
    [
      "Daniel Aquino",
      "Record observations separately from assumptions. If we did not inspect something, say so.",
    ],
    [
      "Pat Riley",
      "Today’s format:\nObserved: label is unreadable.\nImpact: equipment ID needs confirmation.\nNext step: ask the site contact.",
    ],
    [
      "Lena Navarro",
      "That is easy to review. A description is more useful than simply writing ‘see photo’.",
    ],
    [
      "Drew Shaw",
      "One lesson from this morning: confirm the asset tag before opening the inspection checklist.",
    ],
    [
      "Theo Ramos",
      "The entrance detail is now in the arrival instructions.",
      {
        reactions: {
          "✅": ["sample-person-alex-lee", "sample-person-daniel-aquino"],
        },
      },
    ],
  ]),
  ...conversation("product-launch", [
    [
      "Marco Villanueva",
      "**Preventive maintenance pilot**\nStarting small: a clear visit checklist, a useful service summary, and a follow-up owner.",
      { pinned: true },
    ],
    [
      "Amara Flores",
      "The first customer conversation should explain what is included before we discuss timing.",
    ],
    [
      "Gabriel Ong",
      "I can draft discovery questions. We need to hear about their current process, not just pitch ours.",
    ],
    [
      "Mika Soriano",
      "Working headline: Fewer surprises. Clearer maintenance. Does that promise match the pilot scope?",
    ],
    [
      "Lena Navarro",
      "Clearer maintenance is fair. Fewer surprises needs evidence; I would keep the first version more specific.",
    ],
    [
      "Mika Soriano",
      "Agreed. Revised: Planned visits. Clear service summaries.",
      { replyToId: "sample-example-product-launch-5" },
    ],
    [
      "Isabel Lim",
      "I will review cost assumptions once the included activities are settled.",
    ],
    [
      "Marco Villanueva",
      "Readiness check is in the thread below. Owners, flag what is still a draft.",
    ],
    [
      "Mara Santos",
      "Keep the pilot bounded. We can decide whether to expand after the first feedback review.",
    ],
  ]),
  ...conversation("parts-and-stock", [
    [
      "Rafael Castillo",
      "Stock check: seal kits counted, gaskets labelled, and the reserve shelf is up to date.",
    ],
    [
      "Leo Mendoza",
      "Can you hold one gasket kit for the Riverside pump job?",
      { recordId: "sample-sr-1004" },
    ],
    [
      "Rafael Castillo",
      "Reserved and labelled with the job reference. It is on the collection shelf.",
    ],
    [
      "Bea Mercado",
      "For the next order, send quantities and the job owner together. That avoids another approval round.",
    ],
    ["Noah Tan", "Empty storage crates are back beside the parts desk."],
    [
      "Leo Mendoza",
      "Collected the kit and signed it out. Nothing else needed for this bench check.",
    ],
    [
      "Rafael Castillo",
      "Thanks. The stock count now reflects the collection.",
      { reactions: { "👍": ["sample-person-bea-mercado"] } },
    ],
  ]),
  ...conversation("finance-desk", [
    [
      "Isabel Lim",
      "Friday review: bring purchase requests with a purpose, owner, and service reference. We can resolve missing context here.",
    ],
    [
      "Chloe Bautista",
      "The draft billing summary is ready. Unconfirmed line items are clearly marked.",
    ],
    [
      "Amara Flores",
      "I will check the service descriptions before customer-facing copies go out.",
    ],
    [
      "Bea Mercado",
      "One request needs a quantity clarification. I have asked Rafael in the parts thread.",
    ],
    [
      "Rafael Castillo",
      "Confirmed: one reserved kit, not a replenishment order. No purchase needed today.",
    ],
    [
      "Isabel Lim",
      "Great, that removes the duplicate request. Thanks for checking before placing the order.",
      {
        reactions: {
          "✅": ["sample-person-bea-mercado", "sample-person-chloe-bautista"],
        },
      },
    ],
  ]),
  ...conversation("coffee-corner", [
    [
      "Mika Soriano",
      "Tiny Friday question: what is the most useful thing on your desk that is not a computer?",
    ],
    [
      "Sam Rivera",
      "A notebook with one page for things I should stop trying to remember.",
    ],
    ["Ava Chen", "A mug large enough that I do not have to keep making tea."],
    [
      "Leo Mendoza",
      "The label maker. I may have a problem.",
      {
        reactions: {
          "😂": ["sample-person-rafael-castillo", "sample-person-mika-soriano"],
        },
      },
    ],
    [
      "Oliver Sy",
      "A short checklist for the first five minutes of the day. Makes starting easier.",
    ],
    ["Eli Cruz", "A very ordinary pen that somehow everyone borrows."],
  ]),
  ...conversation("learning-lab", [
    [
      "Oliver Sy",
      "Next show-and-tell: writing a handover someone can act on without a follow-up call.",
    ],
    [
      "Lena Navarro",
      "Bring a before-and-after example. Remove customer contact details before sharing.",
    ],
    [
      "Sam Rivera",
      "My template is `owner → next action → next update`. Happy to walk through an example.",
    ],
    [
      "Chloe Bautista",
      "Could we include a finance handover too? Pending approval needs an owner just like a site visit.",
    ],
    [
      "Oliver Sy",
      "Yes. Let’s compare a field handover and a purchase request side by side.",
    ],
    [
      "Daniel Aquino",
      "I will cover how to distinguish a confirmed observation from something that needs checking.",
    ],
    [
      "Lena Navarro",
      "That gives us a useful 15-minute session. I will bring the review checklist.",
      { attachment: "Handover review checklist — example.txt" },
    ],
  ]),
  ...conversation("dm-sofia", [
    [
      "Sofia Garcia",
      "Hi Eli, can we use 11:30 as the next Riverside update time?",
    ],
    [
      "Eli Cruz",
      "Yes, Morgan confirmed the workshop check will be ready by then.",
    ],
    [
      "Sofia Garcia",
      "Perfect. I will make the call and leave the summary in customers.",
    ],
    ["Eli Cruz", "Thanks. I will keep dispatch available if anything changes."],
  ]),
  ...conversation("dm-noah", [
    [
      "Noah Tan",
      "Eli, the spare tool kit is loaded. Do you need a second crate for the afternoon?",
    ],
    [
      "Eli Cruz",
      "One is enough for the current plan. Sam has kept a buffer for changes.",
    ],
    [
      "Noah Tan",
      "Understood. I will leave the second crate on the dispatch shelf.",
    ],
  ]),
  ...conversation("dm-mara", [
    [
      "Mara Santos",
      "The handover format is working well. Is anything still slowing the team down?",
    ],
    [
      "Eli Cruz",
      "Mostly late arrival changes. Posting an owner beside each update has helped.",
    ],
    [
      "Mara Santos",
      "Let’s bring one example to the catch-up and agree a small improvement.",
    ],
  ]),
  ...conversation("dm-isabel", [
    [
      "Isabel Lim",
      "Quick check: is the gasket request a purchase or a stock reservation?",
    ],
    [
      "Eli Cruz",
      "A reservation. Rafael already has a kit available for the job.",
    ],
    ["Isabel Lim", "Thanks, I will mark the purchase question resolved."],
  ]),
  ...conversation("dm-oliver", [
    [
      "Oliver Sy",
      "Would you share your handover template at the learning session?",
    ],
    [
      "Eli Cruz",
      "Sure. I will use the dispatch update to explain the owner and callback time.",
    ],
    [
      "Oliver Sy",
      "That will work nicely. I will put you after Lena’s checklist walkthrough.",
    ],
  ]),
];

function discussion(
  channel: string,
  messageNumber: number,
  resolved: boolean,
  entries: Entry[],
): Thread {
  const id = `sample-example-thread-${channel}-${messageNumber}`;
  return {
    id,
    conversation: `sample-channel-${channel}`,
    messageId: `sample-example-${channel}-${messageNumber}`,
    resolved,
    subscribed: !resolved,
    replies: entries.map(([author, text, extra], index) => ({
      id: `${id}-reply-${index + 1}`,
      conversation: id,
      author,
      authorId: authorId(author),
      text,
      created: Date.UTC(
        2026,
        8,
        11,
        1,
        (messageNumber - 1) * 19 + (index + 1) * 5,
      ),
      pinned: false,
      ...extra,
    })),
  };
}
export const EXAMPLE_THREADS: Thread[] = [
  discussion("operations", 3, true, [
    ["Morgan Kim", "I will own the workshop update. The check is on schedule."],
    ["Sofia Garcia", "I will own the customer call once your note is in."],
    [
      "Eli Cruz",
      "Both owners are in the handover. Marking this coordination question resolved.",
    ],
  ]),
  discussion("workshop", 1, true, [
    ["Rafael Castillo", "The kit label matches the reserved stock item."],
    ["Leo Mendoza", "Contents checked: seal and matching gasket present."],
    ["Lena Navarro", "Inspection note reviewed. No missing details."],
    ["Morgan Kim", "Thanks all. Ready for the customer update."],
  ]),
  discussion("dispatch", 8, false, [
    ["Sam Rivera", "Keeping the buffer until the morning walkthroughs finish."],
    ["Noah Tan", "We have a van available if a visit needs to move."],
    [
      "Eli Cruz",
      "I will confirm the afternoon plan after the last site update.",
    ],
  ]),
  discussion("customers", 1, true, [
    ["Ava Chen", "I removed the technical shorthand from the draft."],
    [
      "Morgan Kim",
      "The summary is accurate and does not imply the whole job is closed.",
    ],
    ["Camille Dizon", "Added the callback time and Sofia as the contact."],
    [
      "Sofia Garcia",
      "Shared with Riverside. They have everything they need for now.",
    ],
  ]),
  discussion("field-notes", 3, false, [
    ["Pat Riley", "Should an unreadable label be an observation or an action?"],
    [
      "Daniel Aquino",
      "The unreadable label is the observation. Confirming the asset ID is the action.",
    ],
    [
      "Lena Navarro",
      "Let’s include both in the checklist example, with separate headings.",
    ],
  ]),
  discussion("product-launch", 8, false, [
    [
      "Marco Villanueva",
      "Checklist: draft. Customer summary: review needed. Follow-up owner: assigned.",
    ],
    ["Amara Flores", "I can review the summary after the customer calls."],
    [
      "Isabel Lim",
      "Cost assumptions are still a draft until included activities are fixed.",
    ],
    ["Gabriel Ong", "Discovery questions are ready for internal feedback."],
    [
      "Mara Santos",
      "Good. Keep open items visible before we choose a pilot start date.",
    ],
  ]),
  discussion("parts-and-stock", 4, true, [
    [
      "Bea Mercado",
      "Checking whether the gasket note is asking for a new order.",
    ],
    [
      "Rafael Castillo",
      "No new order. The kit is reserved from existing stock.",
    ],
    ["Leo Mendoza", "Collected and signed out now."],
    ["Bea Mercado", "Resolved—no purchase request required."],
  ]),
  discussion("finance-desk", 2, false, [
    [
      "Chloe Bautista",
      "Two service descriptions still need the account owner’s review.",
    ],
    ["Amara Flores", "I will confirm the wording before lunch."],
    ["Isabel Lim", "Leave the draft label on until that review is complete."],
  ]),
  discussion("team-wins", 5, true, [
    ["Leo Mendoza", "The larger labels help when both hands are full."],
    ["Rafael Castillo", "I used the same shelf names as the stock list."],
    [
      "Lena Navarro",
      "Simple and consistent. Let’s keep that naming for the next shelf too.",
    ],
  ]),
  discussion("learning-lab", 1, false, [
    [
      "Eli Cruz",
      "I can show the dispatch example with an owner and callback time.",
    ],
    [
      "Chloe Bautista",
      "I will bring the purchase request example for comparison.",
    ],
    ["Oliver Sy", "Great. Five minutes each, then questions."],
    [
      "Sam Rivera",
      "Can we finish with one template people can copy into their next handover?",
    ],
  ]),
];
export const EXAMPLE_DIRECTS: Direct[] = [
  { id: "sample-dm-sofia", user: "Sofia Garcia", read: false, blocked: false },
  { id: "sample-dm-noah", user: "Noah Tan", read: true, blocked: false },
  { id: "sample-dm-mara", user: "Mara Santos", read: false, blocked: false },
  { id: "sample-dm-isabel", user: "Isabel Lim", read: true, blocked: false },
  { id: "sample-dm-oliver", user: "Oliver Sy", read: false, blocked: false },
];
