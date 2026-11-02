// Manage invite codes for friends.
//   node scripts/invites.mjs add <name>      creates a code and prints it once
//   node scripts/invites.mjs list            shows who has a code
//   node scripts/invites.mjs remove <name>   revokes it, ending that person's sessions at once
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCode, hashCode, readInvites, writeInvites } from "../src/invites.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.env.INVITES_FILE || path.join(serverDir, "invites.json");
const [command, ...rest] = process.argv.slice(2);
const name = rest.join(" ").trim();
const invites = readInvites(file);

if (command === "add" && name) {
  if (invites.some((invite) => invite.name.toLowerCase() === name.toLowerCase())) {
    console.error(`${name} already has a code. Remove it first to make a new one.`);
    process.exit(1);
  }
  const code = generateCode();
  writeInvites(file, [...invites, { name, hash: hashCode(code), createdAt: new Date().toISOString() }]);
  console.log(`Invite code for ${name}: ${code}`);
  console.log("It isn't stored anywhere in readable form, so send it now. If it's lost, remove and add again.");
} else if (command === "remove" && name) {
  const remaining = invites.filter((invite) => invite.name.toLowerCase() !== name.toLowerCase());
  if (remaining.length === invites.length) {
    console.error(`No invite named ${name}.`);
    process.exit(1);
  }
  writeInvites(file, remaining);
  console.log(`Removed ${name}. Their sessions end immediately.`);
} else if (command === "admin" && name) {
  // Lets this person approve requests and remove people from the app's People screen.
  const target = invites.find((invite) => invite.name.toLowerCase() === name.toLowerCase());
  if (!target) {
    console.error(`No invite named ${name}.`);
    process.exit(1);
  }
  target.admin = true;
  writeInvites(file, invites);
  console.log(`${target.name} can now approve requests and remove people in the app.`);
} else if (command === "list") {
  if (!invites.length) console.log("No invites yet.");
  for (const invite of invites) console.log(`${invite.name}${invite.admin ? " [owner]" : ""}  (added ${invite.createdAt?.slice(0, 10) || "?"})`);
} else {
  console.log("Usage: node scripts/invites.mjs add <name> | list | remove <name> | admin <name>");
  process.exit(command ? 1 : 0);
}
