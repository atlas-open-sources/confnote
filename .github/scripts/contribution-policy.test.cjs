const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { PASSPHRASE, evaluate, issueNumbers, run } = require("./contribution-policy.cjs");
const body = `Closes #12\nAgent: Codex\nAgent-Passphrase: ${PASSPHRASE}\n## How I tested it\n\`\`\`text\nmake test\n12 passed\n\`\`\`\n## Before / after\nNot applicable: this changes a parser without visible UI.\n`;
test("accepted issue, exact phrase, test output and presentation pass", () => {
  assert.deepEqual(evaluate(body, [12]), []);
  assert.deepEqual(evaluate(body, []), ["unsolicited", "needs-accepted-issue"]);
  assert(evaluate(body.replace("Agent: Codex", ""), [12]).includes("needs-agent-disclosure"));
  assert(evaluate(body.replace(PASSPHRASE, "different"), [12]).includes("needs-human-passphrase"));
  assert(evaluate(body.replace("12 passed", "TODO"), [12]).includes("needs-testing-evidence"));
  assert(evaluate(body.replace(/Not applicable:.+/, ""), [12]).includes("needs-presentation"));
  assert(evaluate(`<!-- ${body} -->`, [12]).includes("needs-human-passphrase"));
  assert.deepEqual(issueNumbers("Closes evil/repo#12 and #14; fixes #13"), [13]);
});
test("failed policy labels and drafts only, never closes or executes PR text", async () => {
  const calls = [];
  const github = { rest: { issues: {
    get: async () => ({ data: { labels: [], pull_request: {} } }),
    createLabel: async (value) => calls.push(["create-label", value]),
    addLabels: async (value) => calls.push(["labels", value]),
    removeLabel: async (value) => calls.push(["remove-label", value]),
  } }, graphql: async (...args) => calls.push(["graphql", ...args]) };
  const context = {repo:{owner:"fixture",repo:"fixture"},payload:{pull_request:{number:42,node_id:"PR_fixture",body:'Closes #12\n${process.exit(99)}',draft:false,labels:[]}}};
  await run({ github, context, core:{setFailed:(message) => calls.push(["failure",message])} });
  assert(calls.some(([kind]) => kind === "labels"));
  const mutation = calls.find(([kind]) => kind === "graphql");
  assert(mutation[1].includes("convertPullRequestToDraft"));
  assert.deepEqual(mutation[2], {id:"PR_fixture"});
  assert(!JSON.stringify(calls).includes("closePullRequest"));
  assert(!JSON.stringify(calls).includes('"state":"closed"'));
});
test("passing gate clears its own labels but does not mark ready or post comments", async () => {
  const removed=[];
  const github={rest:{issues:{get:async()=>({data:{labels:[{name:"accepted"}]}}),removeLabel:async value=>removed.push(value.name)}}};
  await run({github,context:{repo:{},payload:{pull_request:{number:1,body,draft:true,labels:[{name:"unsolicited"},{name:"custom"}]}}},core:{setFailed:()=>assert.fail("unexpected failure")}});
  assert.deepEqual(removed,["unsolicited"]);
});
test("privileged workflow only checks out the trusted default branch", () => {
  const workflow=readFileSync(new URL("../workflows/contribution-policy.yml", `file://${__filename}`),"utf8");
  assert(workflow.includes("pull_request_target:"));
  assert(workflow.includes("ref: ${{ github.event.repository.default_branch }}"));
  assert(!workflow.includes("pull_request.head"));
  assert(!workflow.includes("github.event.pull_request.body"));
});
