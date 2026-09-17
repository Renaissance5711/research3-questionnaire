// Supabase Edge Function for the Research 3 questionnaire.
// Public actions: assignment and submit.
// Researcher-only actions: stats and export (x-admin-token or token query).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store",
};

const ARCHITECTURES = ["G1", "G2", "G3", "G4"] as const;
const PAIRS = ["ES", "ER", "SR"] as const;
const CASES = { E: ["E1", "E2", "E3"], S: ["S1", "S2", "S3"], R: ["R1", "R2", "R3"] };

type JsonObject = Record<string, unknown>;

function json(data: JsonObject, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeCompany(value: unknown) {
  return String(value ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/(有限责任公司|股份有限公司|有限公司|集团公司|集团)$/g, "")
    .toLowerCase();
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function pick<T>(values: readonly T[]) {
  return values[Math.floor(Math.random() * values.length)];
}

function chooseLeast<T>(values: readonly T[], counts: Map<T, number>) {
  const minimum = Math.min(...values.map((value) => counts.get(value) ?? 0));
  return pick(values.filter((value) => (counts.get(value) ?? 0) === minimum));
}

async function selectBalanced(db: ReturnType<typeof client>) {
  const existing = await db.from("research3_teams").select("architecture_id,pair,case_e,case_s,case_r");
  if (existing.error) throw existing.error;
  const rows = existing.data ?? [];
  const architectureCounts = new Map(ARCHITECTURES.map((value) => [value, 0]));
  for (const row of rows) architectureCounts.set(row.architecture_id, (architectureCounts.get(row.architecture_id) ?? 0) + 1);
  const architecture_id = chooseLeast(ARCHITECTURES, architectureCounts);

  const pairCounts = new Map(PAIRS.map((value) => [value, 0]));
  for (const row of rows.filter((value) => value.architecture_id === architecture_id)) pairCounts.set(row.pair, (pairCounts.get(row.pair) ?? 0) + 1);
  const pair = chooseLeast(PAIRS, pairCounts);
  const scopedRows = rows.filter((value) => value.architecture_id === architecture_id && value.pair === pair);
  const caseFor = (kind: keyof typeof CASES, column: "case_e" | "case_s" | "case_r") => {
    const counts = new Map(CASES[kind].map((value) => [value, 0]));
    for (const row of scopedRows) counts.set(row[column], (counts.get(row[column]) ?? 0) + 1);
    return chooseLeast(CASES[kind], counts);
  };
  return { architecture_id, pair, case_e: caseFor("E", "case_e"), case_s: caseFor("S", "case_s"), case_r: caseFor("R", "case_r") };
}

function majorityDecision(votes: number[]) {
  const counts = new Map<number, number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  const max = counts.size ? Math.max(...counts.values()) : 0;
  const candidates = [...counts.entries()].filter(([, count]) => count === max).map(([vote]) => vote).sort((a, b) => a - b);
  return {
    votes,
    winner: max >= 2 && candidates.length ? candidates[0] : null,
    vote_count: max,
    status: max >= 2 ? "majority" : (votes.length >= 3 ? "runoff_required" : "incomplete"),
    runoff_candidates: max >= 2 ? [] : candidates,
  };
}

function factors(architecture: string) {
  return {
    structure_factor: Number(architecture === "G2" || architecture === "G4"),
    division_factor: Number(architecture === "G3" || architecture === "G4"),
  };
}

function client() {
  const url = Deno.env.get("SUPABASE_URL");
  // Supabase projects created with the current API-key model expose
  // SUPABASE_SECRET_KEYS (a JSON map) instead of always populating the
  // legacy SUPABASE_SERVICE_ROLE_KEY. Prefer the legacy value when present,
  // then fall back to the first configured secret key.
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!key) {
    try {
      const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
      if (secretKeys && typeof secretKeys === "object") {
        const values = Object.values(secretKeys).filter((value) => typeof value === "string");
        key = String(values[0] ?? "");
      }
    } catch {
      key = "";
    }
  }
  if (!url || !key) throw new Error("Supabase service environment is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function assignment(company: unknown) {
  const normalized = normalizeCompany(company);
  if (normalized.length < 2) throw new Error("company name is too short");
  const salt = Deno.env.get("RESEARCH3_HASH_SALT");
  if (!salt) throw new Error("RESEARCH3_HASH_SALT is not configured");
  const companyHash = (await sha256(`${salt}|${normalized}`)).slice(0, 16);
  const teamId = `T-${companyHash.slice(0, 10).toUpperCase()}`;
  const db = client();
  const existing = await db.from("research3_teams").select("*").eq("company_hash", companyHash).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return publicAssignment(existing.data);

  const balanced = await selectBalanced(db);
  const architecture_id = balanced.architecture_id;
  const { structure_factor, division_factor } = factors(architecture_id);
  const row = {
    team_id: teamId,
    company_hash: companyHash,
    architecture_id,
    structure_factor,
    division_factor,
    pair: balanced.pair,
    case_e: balanced.case_e,
    case_s: balanced.case_s,
    case_r: balanced.case_r,
  };
  const inserted = await db.from("research3_teams").insert(row).select("*").single();
  // Two people can enter the same company at almost the same time. In that
  // case the unique company_hash constraint wins and both receive one team.
  if (inserted.error) {
    const retry = await db.from("research3_teams").select("*").eq("company_hash", companyHash).single();
    if (retry.error) throw inserted.error;
    return publicAssignment(retry.data);
  }
  return publicAssignment(inserted.data);
}

function publicAssignment(row: JsonObject) {
  return {
    team_id: row.team_id,
    architecture_id: row.architecture_id,
    structure_factor: row.structure_factor,
    division_factor: row.division_factor,
    pair: row.pair,
    case_e: row.case_e,
    case_s: row.case_s,
    case_r: row.case_r,
  };
}

function cleanPayload(value: unknown): JsonObject {
  const source = (value && typeof value === "object") ? value as JsonObject : {};
  const payload: JsonObject = { ...source };
  delete payload.company_name;
  return payload;
}

async function submit(body: JsonObject) {
  const teamId = String(body.team_id ?? "");
  const memberSlot = String(body.member_slot ?? "");
  if (!teamId || !["1", "2", "3"].includes(memberSlot)) throw new Error("team_id and member_slot are required");
  const db = client();
  const team = await db.from("research3_teams").select("team_id").eq("team_id", teamId).maybeSingle();
  if (team.error) throw team.error;
  if (!team.data) throw new Error("unknown team assignment");
  const payload = cleanPayload(body.payload);
  const previous = await db.from("research3_submissions").select("submission_id").eq("team_id", teamId).eq("member_slot", memberSlot).maybeSingle();
  if (previous.error) throw previous.error;
  const result = await db.from("research3_submissions")
    .upsert({ team_id: teamId, member_slot: memberSlot, role: String(body.role ?? payload.role ?? ""), payload }, { onConflict: "team_id,member_slot" })
    .select("submission_id,team_id")
    .single();
  if (result.error) throw result.error;
  return { ...result.data, overwritten: Boolean(previous.data), write_status: previous.data ? "updated" : "created" };
}

function assignedTasks(team: JsonObject) {
  const tasks: Array<{ task: string; case_id: string }> = [];
  if (String(team.pair).includes("E")) tasks.push({ task: "E", case_id: String(team.case_e) });
  if (String(team.pair).includes("S")) tasks.push({ task: "S", case_id: String(team.case_s) });
  if (String(team.pair).includes("R")) tasks.push({ task: "R", case_id: String(team.case_r) });
  return tasks;
}

function submittedVote(payload: JsonObject, caseId: string, memberSlot: string) {
  const direct = payload[`${caseId}-vote-main-${memberSlot}`];
  const legacy = payload[`${caseId}-vote-main`];
  const value = direct ?? legacy;
  const match = String(value ?? "").match(/^\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function teamDecision(team: JsonObject, submissions: JsonObject[]) {
  const teamRows = submissions.filter((row) => row.team_id === team.team_id);
  const memberSlots = [...new Set(teamRows.map((row) => String(row.member_slot)))].sort();
  const decisions: JsonObject[] = [];
  for (const assigned of assignedTasks(team)) {
    const votes = teamRows
      .map((row) => submittedVote((row.payload ?? {}) as JsonObject, assigned.case_id, String(row.member_slot)))
      .filter((value): value is number => value !== null);
    decisions.push({ task: assigned.task, case_id: assigned.case_id, ...majorityDecision(votes) });
  }
  return { team_id: team.team_id, architecture_id: team.architecture_id, pair: team.pair, member_slots: memberSlots, members_submitted: memberSlots.length, complete: memberSlots.length >= 3, decisions };
}

function numericValues(rows: JsonObject[], suffix: string) {
  const values: number[] = [];
  for (const row of rows) {
    const payload = (row.payload && typeof row.payload === "object") ? row.payload as JsonObject : {};
    for (const [key, value] of Object.entries(payload)) {
      if (key.endsWith(suffix)) {
        const match = String(value).match(/^\s*(\d+(?:\.\d+)?)/);
        if (match) values.push(Number(match[1]));
      }
    }
  }
  return values;
}

function mean(values: number[]) {
  return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null;
}

async function aggregate() {
  const db = client();
  const teamsResult = await db.from("research3_teams").select("team_id,architecture_id,pair,case_e,case_s,case_r,created_at").order("created_at");
  const submissionsResult = await db.from("research3_submissions").select("submission_id,team_id,member_slot,role,payload,created_at").order("created_at");
  if (teamsResult.error) throw teamsResult.error;
  if (submissionsResult.error) throw submissionsResult.error;
  const teams = teamsResult.data ?? [];
  const submissions = submissionsResult.data ?? [];
  const byTeam = new Map(teams.map((team) => [team.team_id, team]));
  const rows = submissions.map((s) => ({ ...s, architecture_id: byTeam.get(s.team_id)?.architecture_id } as JsonObject));
  const teamDecisions = teams.map((team) => teamDecision(team as JsonObject, submissions as JsonObject[]));
  const completedTeams = teamDecisions.filter((team) => team.complete).length;
  const byArchitecture = ARCHITECTURES.map((architecture_id) => {
    const archTeams = teams.filter((t) => t.architecture_id === architecture_id);
    const archRows = rows.filter((r) => r.architecture_id === architecture_id);
    const archDecisions = teamDecisions.filter((team) => team.architecture_id === architecture_id);
    return { architecture_id, teams: archTeams.length, completed_teams: archDecisions.filter((team) => team.complete).length, submissions: archRows.length, mean_final_probability: mean(numericValues(archRows, "-final-prob")), mean_ai_influence: mean(numericValues(archRows, "-ai-influence")) };
  });
  const byPair = PAIRS.map((pair) => ({ pair, teams: teams.filter((t) => t.pair === pair).length })).filter((row) => row.teams > 0);
  const byCase: JsonObject[] = [];
  for (const [column, kind] of [["case_e", "E"], ["case_s", "S"], ["case_r", "R"]] as const) {
    const counts = new Map<string, number>();
    for (const team of teams) counts.set(team[column], (counts.get(team[column]) ?? 0) + 1);
    for (const [case_id, count] of [...counts.entries()].sort()) byCase.push({ kind, case_id, teams: count });
  }
  const byTask: JsonObject[] = [];
  for (const task of ["E", "S", "R"]) for (const architecture_id of ARCHITECTURES) {
    const probabilities: number[] = [];
    for (const row of rows.filter((r) => r.architecture_id === architecture_id)) {
      const payload = row.payload as JsonObject;
      for (const [key, value] of Object.entries(payload)) {
        if (new RegExp(`^${task}[1-3]-final-prob$`).test(key)) {
          const match = String(value).match(/^\s*(\d+(?:\.\d+)?)/); if (match) probabilities.push(Number(match[1]));
        }
      }
    }
    if (probabilities.length) byTask.push({ task, architecture_id, submissions: probabilities.length, mean_final_probability: mean(probabilities) });
  }
  return { generated_at: new Date().toISOString(), teams_total: teams.length, submissions_total: submissions.length, completed_teams: completedTeams, by_architecture: byArchitecture, by_pair: byPair, by_case: byCase, by_task: byTask, team_decisions: teamDecisions };
}

function authorized(req: Request, url: URL) {
  const expected = Deno.env.get("RESEARCH3_ADMIN_TOKEN") ?? "";
  if (!expected) return false;
  return req.headers.get("x-admin-token") === expected || url.searchParams.get("token") === expected;
}

async function exportRows() {
  const db = client();
  const teams = await db.from("research3_teams").select("team_id,architecture_id,pair,case_e,case_s,case_r,created_at").order("created_at");
  const submissions = await db.from("research3_submissions").select("submission_id,team_id,member_slot,role,payload,created_at").order("created_at");
  if (teams.error) throw teams.error;
  if (submissions.error) throw submissions.error;
  return { teams: teams.data ?? [], submissions: submissions.data ?? [] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || url.pathname.split("/").pop() || "health";
  try {
    if (req.method === "GET" && action === "assignment") return json({ ok: true, ...(await assignment(url.searchParams.get("company"))) });
    if (req.method === "POST" && action === "submit") return json({ ok: true, ...(await submit(await req.json())) });
    if ((action === "stats" || action === "export") && !authorized(req, url)) return json({ ok: false, error: "admin authorization required" }, 401);
    if (req.method === "GET" && action === "stats") return json({ ok: true, ...(await aggregate()) });
    if (req.method === "GET" && action === "export") return json({ ok: true, ...(await exportRows()) });
    if (req.method === "GET" && action === "health") return json({ ok: true, service: "research3" });
    return json({ ok: false, error: "not found" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 400);
  }
});
