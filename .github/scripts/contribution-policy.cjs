"use strict";

const PASSPHRASE = "hello kitty blah blah curry";
const POLICY_LABELS = ["unsolicited", "needs-accepted-issue", "needs-human-passphrase", "needs-testing-evidence", "needs-presentation", "needs-agent-disclosure"];

function issueNumbers(body) {
  return [...new Set([...body.matchAll(/\b(?:closes|fixes|resolves)\s+#([1-9]\d*)\b/gi)].map((match) => Number(match[1])))].slice(0, 10);
}
function section(body, heading) {
  const sections = body.split(/^##\s+/m).slice(1);
  const found = sections.find((value) => value.split("\n", 1)[0].trim().toLowerCase() === heading.toLowerCase());
  return found ? found.slice(found.indexOf("\n") + 1).trim() : "";
}
function evaluate(body, acceptedIssueNumbers) {
  const clean = String(body || "").replace(/<!--[\s\S]*?-->/g, "");
  const labels = [];
  if (!issueNumbers(clean).some((number) => acceptedIssueNumbers.includes(number))) labels.push("needs-accepted-issue");
  if (!/^Agent:[ \t]*\S.+$/m.test(clean)) labels.push("needs-agent-disclosure");
  const supplied = /^Agent-Passphrase:[ \t]*(.+)$/m.exec(clean)?.[1].trim();
  if (supplied !== PASSPHRASE) labels.push("needs-human-passphrase");
  const evidence = section(clean, "How I tested it");
  if (!/```[^\n]*\n[\s\S]+?```/.test(evidence) || /\b(?:TODO|TBD|paste output here)\b/i.test(evidence)) labels.push("needs-testing-evidence");
  const presentation = section(clean, "Before / after");
  if (!/!\[[^\]]*\]\([^\s)]+\)|https:\/\/\S+|Not applicable:\s*\S.+/i.test(presentation)) labels.push("needs-presentation");
  if (labels.length) labels.unshift("unsolicited");
  return labels;
}
async function run({ github, context, core }) {
  const pull = context.payload.pull_request;
  if (!pull) throw new Error("pull_request payload required");
  const body = String(pull.body || "");
  const accepted = [];
  for (const number of issueNumbers(body)) {
    try {
      const { data } = await github.rest.issues.get({ ...context.repo, issue_number: number });
      if (!data.pull_request && data.labels.some((label) => (typeof label === "string" ? label : label.name) === "accepted")) accepted.push(number);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const labels = evaluate(body, accepted);
  for (const label of labels) {
    try { await github.rest.issues.createLabel({ ...context.repo, name: label, color: "d4c5f9", description: "Contribution policy needs attention" }); }
    catch (error) { if (error.status !== 422) throw error; }
  }
  if (labels.length) await github.rest.issues.addLabels({ ...context.repo, issue_number: pull.number, labels });
  const current = (pull.labels || []).map((label) => typeof label === "string" ? label : label.name);
  for (const name of POLICY_LABELS.filter((label) => current.includes(label) && !labels.includes(label))) {
    await github.rest.issues.removeLabel({ ...context.repo, issue_number: pull.number, name });
  }
  if (labels.length && !pull.draft) {
    await github.graphql("mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id}}}", { id: pull.node_id });
  }
  if (labels.length) core.setFailed(`Contribution policy: ${labels.filter((label) => label !== "unsolicited").join(", ")}. See CONTRIBUTING.md. The PR remains open.`);
  return labels;
}
module.exports = { PASSPHRASE, issueNumbers, evaluate, run };
