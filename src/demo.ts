import { AgentState } from "./schema.js";
import { applyBatch, derive } from "./commands.js";
import { functionDeclarations } from "./gemini-tools.js";

const st = AgentState.parse({
  event: { id: "e1", title: "Bobby & Ananya", eventType: "wedding", city: "Hyderabad", totalBudgetPaise: 1500000_00,
    startDate: "2027-03-10", endDate: "2027-03-15", ext: { type: "wedding", partners: ["Bobby", "Ananya"] } },
  subEvents: [
    { id: "s1", name: "Haldi", slug: "haldi", date: "2027-03-11", startMin: 600, endMin: 780 },   // Thu
    { id: "s2", name: "Sangeet", slug: "sangeet", date: "2027-03-13", startMin: 1140, endMin: 1380 },
    { id: "s3", name: "Muhurtham", slug: "muhurtham", date: "2027-03-14", startMin: 420, endMin: 600, isMain: true, phase: "main" },
  ],
  budgetItems: [
    { id: "b1", category: "decor", label: "Haldi marigold decor", subEventId: "s1", plannedPaise: 80000_00, committedPaise: 30000_00 },
    { id: "b2", category: "decor", label: "Sangeet stage", subEventId: "s2", plannedPaise: 150000_00, committedPaise: 100000_00 },
    { id: "b3", category: "decor", label: "Mandap", subEventId: "s3", plannedPaise: 200000_00, committedPaise: 200000_00, locked: true },
    { id: "b4", category: "catering", label: "Lunch", subEventId: "s3", plannedPaise: 600000_00,
      payments: [{ id: "p1", amountPaise: 100000_00, kind: "deposit", dueDate: "2026-10-15" }] },
  ],
  timeline: [
    { id: "t1", subEventId: "s1", label: "Haldi application", startMin: 600, endMin: 690 },
    { id: "t2", subEventId: "s1", label: "Lunch", startMin: 690, endMin: 780 },
    { id: "t3", subEventId: "s3", label: "Muhurtham", startMin: 470, endMin: 500, anchored: true },
  ],
  tasks: [{ id: "k1", title: "Confirm haldi florist", subEventId: "s1", dueOffsetDays: -14 }],
});

// What Gemini emits for "Cut ₹20k from decor and move the Haldi to Friday":
const call = { summary: "Cut ₹20,000 from decor; Haldi moves to Friday", commands: [
  { op: "adjust_budget", category: "decor", deltaPaise: -2000000, reason: "user request" },
  { op: "move_sub_event", subEvent: "haldi", to: { weekday: "friday" } },
]};
const r = applyBatch(st, call);
console.log(JSON.stringify(r.ok ? r.log : r.error));
if (r.ok) {
  console.log(r.state.budgetItems.filter(b => b.category === "decor").map(b => `${b.label}: ₹${b.plannedPaise / 100}`).join(" | "));
  console.log(r.state.subEvents[0]!.date, derive(r.state, "2026-10-20").tasksWithDates[0]!.dueDate);
}
console.log("same input → same output:", JSON.stringify(applyBatch(st, call)) === JSON.stringify(r));
console.log("overcut:", JSON.stringify((applyBatch(st, { summary: "x", commands: [{ op: "adjust_budget", category: "decor", deltaPaise: -20000000 }] }) as any).error));
console.log("bad weekday window:", JSON.stringify(((applyBatch(st, { summary: "x", commands: [{ op: "move_sub_event", subEvent: "haldi", to: { weekday: "monday" } }] }) as any).error)));
console.log("overdue:", JSON.stringify(derive(st, "2026-10-20").overduePayments.map(p => p.item)));
console.log("schema keys:", Object.keys((functionDeclarations[0].parametersJsonSchema as any).properties));
