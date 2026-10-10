/**
 * Phone transcripts from "Aangan_Sep 2026_Enquiries.pdf" (already anonymised by the studio), used as
 * TEST FIXTURES for the live extraction check. They are never written to production tables.
 * `expected` is the outcome the qualified.md rubric gives for each call.
 */
export interface TranscriptFixture {
  id: string;
  date: string;
  expectedCallType: string;
  expected: ("green" | "amber" | "red" | "needs_review" | "not_a_lead")[];
  text: string;
}

export const TRANSCRIPTS: TranscriptFixture[] = [
  {
    id: "T01",
    date: "2026-09-02",
    expectedCallType: "new_enquiry",
    expected: ["green"],
    text: `Agent: Good morning, Aangan Studio.
Caller: Hi, I'm Priya. I got your number from a friend — Shruti Joshi. She had her flat done by you in Aundh.
Agent: Of course — thank you for calling. What are you looking to do?
Caller: We have a 3BHK in Kothrud — Dahanukar Colony. We bought it two years ago and it still looks like the builder flat. We want to redo the whole thing — kitchen, living room, both bedrooms.
Agent: That sounds like a complete redesign. How big is the apartment?
Caller: About 1,400 sq ft carpet.
Agent: And your timeline?
Caller: We'd like to be done by March. We're in no rush.
Agent: Perfect. Are you the owner?
Caller: Yes — myself and my husband. He knows we're calling and is happy to go ahead.`,
  },
  {
    id: "T03",
    date: "2026-09-03",
    expectedCallType: "new_enquiry",
    expected: ["red"],
    text: `Agent: Good afternoon, Aangan Studio.
Caller: Hello, I saw your work on LinkedIn. My name is Suresh Patil. I'm in Nashik — would you be able to take on a project here? I want to redo my home office and study.
Agent: Thank you for calling. We only work in Pune and PCMC at the moment.
Caller: Not even for a smaller project?
Agent: Even for a smaller project, our execution depends on our contractors being on-site. I'm sorry we can't help.
Caller: Alright, understood. Thanks.`,
  },
  {
    id: "T04",
    date: "2026-09-04",
    expectedCallType: "new_enquiry",
    expected: ["red"],
    text: `Agent: Good morning, Aangan Studio.
Caller: Hi — can someone come and give us some ideas for our living room? We're not planning to do the full thing right now. Just want suggestions on colours, furniture arrangement, what to change.
Agent: We're a full-service studio — our projects include design and execution together. We don't do advisory or consultation-only visits.
Caller: Oh I see. No, we're just exploring for now. Maybe later.`,
  },
  {
    id: "T06",
    date: "2026-09-05",
    expectedCallType: "new_enquiry",
    expected: ["green"],
    text: `Agent: Good afternoon, Aangan Studio.
Caller: Hi, I'm calling about a commercial project. We're a startup — just got our first proper office space in Baner. About 800 sq ft. We need workstations for 20 people, a small cabin, a meeting room, and a break area.
Agent: What's the state of the space right now?
Caller: Bare shell — just columns and floor. Nothing else.
Agent: Full fitout from scratch. And the timeline?
Caller: We want to be operational by December. Our team is working from home currently.
Agent: Are you the decision-maker for this?
Caller: Yes, I'm the founder.`,
  },
  {
    id: "T09",
    date: "2026-09-10",
    expectedCallType: "existing_project_complaint",
    expected: ["not_a_lead"],
    text: `Agent: Good morning, Aangan Studio.
Caller: I need to speak to someone right now. My project has been going for three months and my designer hasn't replied in five days. This is not acceptable.
Agent: I'm very sorry. Can I take your name and project details?
Caller: Sheetal Deshpande. My designer is Aryan. Flat in Viman Nagar — 2BHK. I've sent three messages and called twice.`,
  },
  {
    id: "T10",
    date: "2026-09-11",
    expectedCallType: "new_enquiry",
    expected: ["red"],
    text: `Agent: Good afternoon, Aangan Studio.
Caller: Hi. I have a 1BHK in Kharadi — about 550 sq ft. I want to do the kitchen and one bedroom. My budget is 1 to 1.5 lakh maximum for everything. Is that possible with you?
Agent: I appreciate you sharing that. For a kitchen redesign and a bedroom with full execution, that would be significantly below what a project of that scope would cost with us.
Caller: Okay, thank you for being straight.`,
  },
  {
    id: "T13",
    date: "2026-09-16",
    expectedCallType: "new_enquiry",
    expected: ["amber", "needs_review"],
    text: `Agent: Good afternoon, Aangan Studio.
Caller: Hi — I want to redo my flat in Aundh. 3BHK, about 1,100 sq ft. What might it cost?
Agent: Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation.
Caller: Kitchen, wardrobes in both bedrooms, living room. But seriously — can't you give me even a rough range?
Agent: Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.
Caller: Fine. Let's book then.`,
  },
  {
    id: "T14",
    date: "2026-09-17",
    expectedCallType: "new_enquiry",
    expected: ["amber", "needs_review"],
    text: `Agent: Good morning, Aangan Studio.
Caller: Hi — I wanted to inquire about an interior project for my parents. They have a 3BHK in Hadapsar — new possession. They want a proper design.
Agent: Will your parents be involved in the decision?
Caller: Yes — I'm doing the initial checking. They don't really use phones much. I'll tell them about the consultation and they'll decide.
Agent: When would you need the project complete?
Caller: No fixed date, they're flexible.`,
  },
  {
    id: "T19",
    date: "2026-09-24",
    expectedCallType: "new_enquiry",
    expected: ["red"],
    text: `Agent: Good afternoon, Aangan Studio.
Caller: Hi — I'm planning to open a restaurant in Koregaon Park. I've seen your work and I love it. Would you be able to design the interiors?
Agent: Restaurant and hospitality interiors are outside our current scope.
Caller: Alright, thanks.`,
  },
];
