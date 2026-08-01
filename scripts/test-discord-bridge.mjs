#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ChannelType } from "discord.js";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".discord-bridge-test-"));
const dataDir = await mkdtemp(join(tmpdir(), "pi-discord-bridge-data-"));
let compatibilityDirectory;

function compileExtensions() {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());
}

async function waitFor(predicate, description) {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (await predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function reactionSequence(messageId) {
	return FakeGateway.lifecycleReactionEvents
		.filter((event) => event.messageId === messageId)
		.map((event) => event.reaction);
}

class FakeGateway {
	static instances = [];
	static activeConnections = 0;
	static maximumActiveConnections = 0;
	static catchUpByThread = new Map();
	static nonceResults = new Map();
	static failSendAt = undefined;
	static failOnceTexts = new Set();
	static sendAttempts = new Map();
	static sendAttemptTimes = new Map();
	static deletedThreads = new Set();
	static lifecycleReactions = new Map();
	static lifecycleReactionEvents = [];
	static failLifecycleOnce = new Set();
	static hangLifecycleFor = new Set();

	connected = false;
	listeners = new Set();
	terminalListeners = new Set();
	projectRequests = [];
	threadRequests = [];
	sent = [];
	threadCounter = 0;

	constructor() {
		FakeGateway.instances.push(this);
	}

	async connect(config) {
		this.config = config;
		this.connected = true;
		FakeGateway.activeConnections++;
		FakeGateway.maximumActiveConnections = Math.max(
			FakeGateway.maximumActiveConnections,
			FakeGateway.activeConnections,
		);
	}

	async disconnect() {
		if (!this.connected) return;
		this.connected = false;
		FakeGateway.activeConnections--;
	}

	onMessage(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async ensureProjectChannel(request) {
		this.projectRequests.push(request);
		return request.mappedChannelId ?? `channel-${this.projectRequests.length}`;
	}

	async ensureSessionThread(request) {
		this.threadRequests.push(request);
		if (request.mappedThreadId && !FakeGateway.deletedThreads.has(request.mappedThreadId)) return request.mappedThreadId;
		return `thread-${++this.threadCounter}-${request.name.slice(-8)}`;
	}

	async fetchMessagesAfter(threadId, afterId) {
		return (FakeGateway.catchUpByThread.get(threadId) ?? []).filter((message) => {
			if (!afterId) return true;
			try {
				return BigInt(message.id) > BigInt(afterId);
			} catch {
				return message.id > afterId;
			}
		});
	}

	async setLifecycleReaction(channelId, messageId, reaction) {
		const key = `${messageId}:${reaction}`;
		if (FakeGateway.hangLifecycleFor.has(key)) return new Promise(() => {});
		if (FakeGateway.failLifecycleOnce.delete(key)) throw new Error("injected Discord reaction failure");
		if (FakeGateway.lifecycleReactions.get(messageId) === reaction) return;
		FakeGateway.lifecycleReactions.set(messageId, reaction);
		FakeGateway.lifecycleReactionEvents.push({ channelId, messageId, reaction, gateway: this });
	}

	async sendText(channelId, text, nonce) {
		FakeGateway.sendAttempts.set(text, (FakeGateway.sendAttempts.get(text) ?? 0) + 1);
		const attemptTimes = FakeGateway.sendAttemptTimes.get(text) ?? [];
		attemptTimes.push(Date.now());
		FakeGateway.sendAttemptTimes.set(text, attemptTimes);
		if (FakeGateway.failOnceTexts.delete(text)) throw new Error("injected transient Discord send failure");
		if (FakeGateway.deletedThreads.has(channelId)) throw new Error("Unknown Channel");
		const existing = FakeGateway.nonceResults.get(nonce);
		if (existing) return existing;
		if (FakeGateway.failSendAt === this.sent.length) throw new Error("injected Discord send failure");
		const id = `sent-${FakeGateway.nonceResults.size + 1}`;
		this.sent.push({ channelId, text, nonce, id });
		FakeGateway.nonceResults.set(nonce, id);
		return id;
	}

	onTerminalError(listener) {
		this.terminalListeners.add(listener);
		return () => this.terminalListeners.delete(listener);
	}

	terminal(error = new Error("injected terminal gateway failure")) {
		for (const listener of this.terminalListeners) listener(error);
	}

	async emit(message) {
		await Promise.all([...this.listeners].map((listener) => listener(message)));
	}
}

function createExtensionHarness(extension, { cwd, sessionId, sessionName, entries = [] }) {
	const events = new Map();
	const commands = new Map();
	const notifications = [];
	const statuses = [];
	const userMessages = [];
	const userWaiters = [];
	let idle = true;
	let injectionError = false;
	const pi = {
		on(name, handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		sendUserMessage(text, options) {
			if (injectionError) throw new Error("injected Pi acceptance failure");
			const message = { text, options };
			userMessages.push(message);
			userWaiters.shift()?.(message);
		},
		getSessionName() {
			return sessionName;
		},
		appendEntry(customType, data) {
			entries.push({ type: "custom", customType, data });
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		ui: {
			notify: (...args) => notifications.push(args),
			setStatus: (...args) => statuses.push(args),
		},
	};
	extension(pi);
	return {
		commands,
		events,
		notifications,
		statuses,
		userMessages,
		entries,
		setIdle(value) { idle = value; },
		setInjectionError(value) { injectionError = value; },
		nextUserMessage() {
			return new Promise((resolveMessage) => userWaiters.push(resolveMessage));
		},
		async emit(name, event = {}) {
			let result;
			for (const handler of events.get(name) ?? []) result = await handler(event, ctx);
			return result;
		},
		async runCommand(name, args = "") {
			return commands.get(name).handler(args, ctx);
		},
	};
}

try {
	compileExtensions();
	const importBuilt = (path) => import(pathToFileURL(join(output, path)));
	const {
		loadDiscordConfig,
		parseDiscordConfig,
		relayPaths,
		saveDiscordConfig,
	} = await importBuilt("extensions/discord/config.js");
	const { PACKAGE_FOOTER_STATUS_KEYS } = await importBuilt("extensions/footer-status.js");
	const { DiscordStateStore } = await importBuilt("extensions/discord/state.js");
	const { LocalRelayClient } = await importBuilt("extensions/discord/relay-client.js");
	const { resolveProjectContext, resolveProjectIdentity } = await importBuilt("extensions/discord/project-identity.js");
	const { discoverTaskTitle, parseTaskTitle } = await importBuilt("extensions/discord/task-title.js");
	const { createDiscordExtension } = await importBuilt("extensions/discord/index.js");
	const { DiscordRelayCore } = await importBuilt("extensions/discord/relay-core.js");
	const { inboundMessageId, stripInboundMarker } = await importBuilt("extensions/discord/bridge.js");
	const { BoundedSocketWriter, MAX_QUEUED_IPC_FRAMES } = await importBuilt("extensions/discord/ipc-writer.js");
	const { isClientFrame } = await importBuilt("extensions/discord/protocol.js");
	const { restartOwnedRelay, tryAcquireLeader } = await importBuilt("extensions/discord/leader.js");
	const {
		assistantText,
		collidingProjectChannelName,
		interactiveUserChunks,
		projectChannelName,
		sessionThreadName,
		splitDiscordText,
	} = await importBuilt("extensions/discord/text.js");
	const {
		assertConfiguredCategory,
		collectChronologicalMessages,
		replaceOwnLifecycleReaction,
		reuseSessionThread,
	} = await importBuilt("extensions/discord/transport.js");

	assert.deepEqual(parseDiscordConfig({ token: " token ", guildId: "12345", categoryId: "" }), {
		token: "token",
		guildId: "12345",
		epoch: 0,
	});
	assert.throws(
		() => parseDiscordConfig({ token: "token", guildId: "12345", categoryId: "not-an-id" }),
		/categoryId must be a Discord ID/,
	);
	assert.doesNotThrow(() => assertConfiguredCategory(
		{ type: ChannelType.GuildCategory, guildId: "12345" },
		"67890",
		"12345",
	));
	assert.throws(
		() => assertConfiguredCategory({ type: ChannelType.GuildText, guildId: "12345" }, "67890", "12345"),
		/Configured Discord category 67890.*not a category/,
	);
	const removedReactions = [];
	const addedReactions = [];
	await replaceOwnLifecycleReaction([
		{ emoji: { name: "👀" }, me: true, users: { async remove(id) { removedReactions.push(["👀", id]); } } },
		{ emoji: { name: "🤔" }, me: false, users: { async remove(id) { removedReactions.push(["🤔", id]); } } },
		{ emoji: { name: "🎉" }, me: true, users: { async remove(id) { removedReactions.push(["🎉", id]); } } },
	], "bot-user", "⚙️", async (reaction) => { addedReactions.push(reaction); });
	assert.deepEqual(removedReactions, [["👀", "bot-user"]], "only the bot's prior lifecycle reaction may be removed");
	assert.deepEqual(addedReactions, ["⚙️"]);
	let addedAfterRemoveFailure = false;
	await assert.rejects(() => replaceOwnLifecycleReaction([
		{ emoji: { name: "🤔" }, me: true, users: { async remove() { throw new Error("Missing Permissions"); } } },
	], "bot-user", "✅", async () => { addedAfterRemoveFailure = true; }), /Missing Permissions/);
	assert.equal(addedAfterRemoveFailure, false, "a replacement must not add until removal succeeds");
	let reopened = false;
	assert.equal(await reuseSessionThread({
		id: "thread-1",
		parentId: "channel-1",
		archived: true,
		isThread: () => true,
		async setArchived(value) { reopened = value === false; },
	}, "channel-1"), "thread-1");
	assert.equal(reopened, true);
	const malformedConfig = join(dataDir, "malformed-config.json");
	await writeFile(malformedConfig, "{oops");
	await assert.rejects(() => loadDiscordConfig(malformedConfig, {}), /Cannot read Discord bridge config/);
	const legacyStateFile = join(dataDir, "legacy-state.json");
	await writeFile(legacyStateFile, JSON.stringify({
		version: 1,
		projects: { "/legacy/project": { channelId: "legacy-channel" } },
		sessions: {
			"legacy-session": {
				cwd: "/legacy/project",
				channelId: "legacy-channel",
				threadId: "legacy-thread",
				lastMessageId: "123",
				pendingMessages: [],
			},
		},
		recentMessageIds: [],
	}));
	const legacyState = await new DiscordStateStore(legacyStateFile).load();
	assert.equal(legacyState.sessions["legacy-session"].threadCursors["legacy-thread"], "123");
	assert.deepEqual(legacyState.sessions["legacy-session"].outboundMessages, []);
	assert.deepEqual(legacyState.sessions["legacy-session"].lifecycleMessages, []);
	const epochConfig = join(dataDir, "epoch-config.json");
	await saveDiscordConfig({ token: "one", guildId: "12345" }, epochConfig);
	const firstEpoch = (await loadDiscordConfig(epochConfig, {})).epoch;
	await saveDiscordConfig({ token: "two", guildId: "12345" }, epochConfig);
	assert.ok((await loadDiscordConfig(epochConfig, {})).epoch > firstEpoch, "serialized config writes must advance the relay epoch");
	const environmentConfig = join(dataDir, "environment-config.json");
	await writeFile(environmentConfig, JSON.stringify({ token: "file-token", guildId: "12345" }));
	const environmentFirst = await loadDiscordConfig(environmentConfig, { DISCORD_TOKEN: "environment-one" });
	const environmentSecond = await loadDiscordConfig(environmentConfig, { DISCORD_TOKEN: "environment-two" });
	assert.ok(environmentSecond.epoch > environmentFirst.epoch, "environment-only effective config changes need an authoritative epoch");

	const gitIdentityDirectory = join(dataDir, "git identity fixtures");
	const mainCheckout = join(gitIdentityDirectory, "main repository");
	const linkedWorktree = join(gitIdentityDirectory, "linked worktree");
	const runGit = (...args) => {
		const result = spawnSync("git", args, { encoding: "utf8" });
		assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
	};
	await mkdir(mainCheckout, { recursive: true });
	runGit("init", "-q", mainCheckout);
	runGit("-C", mainCheckout, "config", "user.email", "discord-test@example.com");
	runGit("-C", mainCheckout, "config", "user.name", "Discord Test");
	await writeFile(join(mainCheckout, "tracked file"), "initial\n");
	runGit("-C", mainCheckout, "add", "tracked file");
	runGit("-C", mainCheckout, "commit", "-qm", "initial");
	runGit("-C", mainCheckout, "worktree", "add", "-qb", "discord-linked", linkedWorktree);
	const linkedSubdirectory = join(linkedWorktree, "directory with spaces");
	await mkdir(linkedSubdirectory);
	const canonicalMainCheckout = await realpath(mainCheckout);
	assert.equal(await resolveProjectIdentity(mainCheckout), canonicalMainCheckout, "a normal checkout must identify its repository root");
	assert.equal(await resolveProjectIdentity(linkedWorktree), canonicalMainCheckout, "a linked worktree must identify its main checkout");
	assert.equal(await resolveProjectIdentity(linkedSubdirectory), canonicalMainCheckout, "a worktree subdirectory must retain repository identity");
	const linkedContext = await resolveProjectContext(linkedSubdirectory);
	assert.equal(linkedContext.projectIdentity, canonicalMainCheckout);
	assert.equal(linkedContext.checkoutRoot, await realpath(linkedWorktree), "task discovery must retain the current linked-worktree root");

	assert.equal(parseTaskTitle("# Heading task\n\nDetails\n"), "Heading task");
	assert.equal(
		parseTaskTitle("---\ntitle: Frontmatter task\nowner: test\n---\n# Heading task\n"),
		"Frontmatter task",
		"valid frontmatter title must take precedence over the first H1",
	);
	assert.equal(parseTaskTitle("---\ntitle: 'Quoted task'\n---\n"), "Quoted task");
	assert.equal(parseTaskTitle("Task details without an explicit title\n"), undefined);
	assert.equal(parseTaskTitle("---\ntitle: Broken task\n# Missing closing delimiter\n"), undefined);
	assert.equal(parseTaskTitle("---\ntitle: First\ntitle: Second\n---\n# Heading\n"), undefined);
	assert.equal(parseTaskTitle(`# ${"x".repeat(201)}\n`), undefined);
	assert.equal(parseTaskTitle("# Binary\0task\n"), undefined);

	const taskMetadataDirectory = join(gitIdentityDirectory, "task metadata cases");
	await mkdir(taskMetadataDirectory);
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), undefined, "absent TASK.md must preserve session-name fallback");
	await writeFile(join(taskMetadataDirectory, "TASK.md"), "---\ntitle: Valid task title\n---\n# Ignored heading\n");
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), "Valid task title");
	await writeFile(join(taskMetadataDirectory, "TASK.md"), "---\ntitle: Malformed without closing frontmatter\n# Heading\n");
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), undefined, "malformed task metadata must preserve session-name fallback");
	await writeFile(join(taskMetadataDirectory, "TASK.md"), `# Oversized\n${"x".repeat(16_384)}\n`);
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), undefined, "oversized task metadata must be ignored");
	await writeFile(join(taskMetadataDirectory, "TASK.md"), Buffer.from([0x23, 0x20, 0xff, 0x0a]));
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), undefined, "non-UTF-8 task metadata must be ignored");
	await rm(join(taskMetadataDirectory, "TASK.md"));
	const outsideTaskFile = join(gitIdentityDirectory, "outside TASK.md");
	await writeFile(outsideTaskFile, "# Unsafe external title\n");
	await symlink(outsideTaskFile, join(taskMetadataDirectory, "TASK.md"));
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), undefined, "symlinked task metadata outside the checkout must be ignored");
	await writeFile(join(linkedWorktree, "TASK.md"), "# Implement task-title thread naming\n");
	assert.equal(await discoverTaskTitle(linkedContext.checkoutRoot), "Implement task-title thread naming");

	const submoduleSource = join(gitIdentityDirectory, "submodule source");
	await mkdir(submoduleSource);
	runGit("init", "-q", submoduleSource);
	runGit("-C", submoduleSource, "config", "user.email", "discord-test@example.com");
	runGit("-C", submoduleSource, "config", "user.name", "Discord Test");
	await writeFile(join(submoduleSource, "submodule file"), "submodule\n");
	runGit("-C", submoduleSource, "add", "submodule file");
	runGit("-C", submoduleSource, "commit", "-qm", "submodule");
	const submoduleCheckout = join(mainCheckout, "modules", "submodule with spaces");
	runGit("-c", "protocol.file.allow=always", "-C", mainCheckout, "submodule", "add", "-q", submoduleSource, "modules/submodule with spaces");
	assert.equal(
		await resolveProjectIdentity(submoduleCheckout),
		await realpath(submoduleCheckout),
		"a submodule must use its working tree instead of internal parent-repository metadata",
	);

	const bareRepository = join(gitIdentityDirectory, "bare repository.git");
	runGit("init", "--bare", "-q", bareRepository);
	assert.equal(await resolveProjectIdentity(bareRepository), await realpath(bareRepository), "a bare repository must remain a stable project identity");

	const sameBasenameOne = join(gitIdentityDirectory, "one", "shared");
	const sameBasenameTwo = join(gitIdentityDirectory, "two", "shared");
	await mkdir(sameBasenameOne, { recursive: true });
	await mkdir(sameBasenameTwo, { recursive: true });
	runGit("init", "-q", sameBasenameOne);
	runGit("init", "-q", sameBasenameTwo);
	assert.notEqual(
		await resolveProjectIdentity(sameBasenameOne),
		await resolveProjectIdentity(sameBasenameTwo),
		"unrelated same-basename repositories must not collapse to one identity",
	);
	const nonGitDirectory = join(gitIdentityDirectory, "ordinary directory");
	await mkdir(nonGitDirectory);
	assert.equal(await resolveProjectIdentity(nonGitDirectory), resolve(nonGitDirectory), "non-Git paths must retain normalized cwd identity");
	assert.equal(
		await resolveProjectIdentity(nonGitDirectory, { gitExecutable: join(gitIdentityDirectory, "missing git") }),
		resolve(nonGitDirectory),
		"missing Git must fall back to normalized cwd",
	);
	const malformedGit = join(gitIdentityDirectory, "malformed git");
	await writeFile(malformedGit, "#!/bin/sh\nprintf 'not-an-absolute-path\\nextra-output\\n'\n");
	await chmod(malformedGit, 0o755);
	assert.equal(
		await resolveProjectIdentity(nonGitDirectory, { gitExecutable: malformedGit }),
		resolve(nonGitDirectory),
		"malformed Git output must fall back to normalized cwd",
	);
	const hangingGit = join(gitIdentityDirectory, "hanging git");
	await writeFile(hangingGit, "#!/bin/sh\nwhile :; do :; done\n");
	await chmod(hangingGit, 0o755);
	const hangingStarted = Date.now();
	assert.equal(
		await resolveProjectIdentity(nonGitDirectory, { gitExecutable: hangingGit, timeoutMs: 25 }),
		resolve(nonGitDirectory),
		"timed-out Git must fall back to normalized cwd",
	);
	assert.ok(Date.now() - hangingStarted < 1_000, "Git project identity resolution must be bounded");

	const identityState = new DiscordStateStore(join(dataDir, "project-identity-state.json"));
	const canonicalChannel = await identityState.resolveProjectChannel(await resolveProjectIdentity(mainCheckout), async () => "canonical-project-channel");
	assert.equal(
		await identityState.resolveProjectChannel(await resolveProjectIdentity(linkedWorktree), async (request) => request.existingChannelId),
		canonicalChannel,
		"main and linked worktree registrations must converge on one project channel",
	);
	const firstIdentityThread = await identityState.resolveSessionThread("identity-main-session", canonicalMainCheckout, canonicalChannel, async () => "identity-thread-main");
	const linkedIdentityThread = await identityState.resolveSessionThread("identity-linked-session", canonicalMainCheckout, canonicalChannel, async () => "identity-thread-linked");
	assert.notEqual(firstIdentityThread.threadId, linkedIdentityThread.threadId, "worktree Pi sessions must retain separate threads");
	await identityState.resolveProjectChannel(linkedWorktree, async () => "legacy-worktree-channel");
	const identityProjects = (await identityState.load()).projects;
	assert.ok(identityProjects[canonicalMainCheckout]);
	assert.ok(identityProjects[resolve(linkedWorktree)], "legacy cwd mappings must remain stored without destructive migration");

	const rollingIdentityState = new DiscordStateStore(join(dataDir, "rolling-project-identity-state.json"));
	const rollingIdentityGateway = new FakeGateway();
	const rollingIdentityCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		rollingIdentityState,
		rollingIdentityGateway,
	);
	await rollingIdentityCore.start();
	const legacyMainRegistration = await rollingIdentityCore.prepareRegistration("legacy-main-client", "legacy-main-generation", {
		cwd: mainCheckout,
		sessionId: "legacy-main-session",
	});
	const legacyLinkedRegistration = await rollingIdentityCore.prepareRegistration("legacy-linked-client", "legacy-linked-generation", {
		cwd: linkedWorktree,
		sessionId: "legacy-linked-session",
	});
	assert.equal(legacyLinkedRegistration.channelId, legacyMainRegistration.channelId, "a new relay must canonicalize registrations from rolling older clients");
	assert.notEqual(legacyLinkedRegistration.threadId, legacyMainRegistration.threadId);
	assert.equal(Object.keys((await rollingIdentityState.load()).projects).length, 1);
	await rollingIdentityCore.stop();

	assert.equal(projectChannelName("/one/My Project"), "my-project");
	assert.equal(projectChannelName("/one/project"), projectChannelName("/two/project"));
	assert.equal(projectChannelName(`/tmp/${"a".repeat(150)}`).length, 100);
	assert.equal(collidingProjectChannelName(`/tmp/${"a".repeat(150)}`).length, 100);
	assert.match(collidingProjectChannelName("/one/project"), /^project-[a-f0-9]{8}$/);
	assert.equal(projectChannelName("/tmp/项目"), "project");
	assert.match(collidingProjectChannelName("/tmp/另一个项目"), /^project-[a-f0-9]{8}$/);
	assert.equal(projectChannelName("/tmp/Café déjà"), "cafe-deja");
	assert.match(sessionThreadName("12345678-abcd", "Fix Things"), /^pi-fix-things-12345678$/);
	assert.equal(sessionThreadName("12345678-abcd"), "pi-session-12345678");
	assert.equal(sessionThreadName("aaaaaaaa-1111", "Shared task"), "pi-shared-task-aaaaaaaa");
	assert.equal(sessionThreadName("bbbbbbbb-2222", "Shared task"), "pi-shared-task-bbbbbbbb");
	assert.notEqual(sessionThreadName("aaaaaaaa-1111", "Shared task"), sessionThreadName("bbbbbbbb-2222", "Shared task"));
	assert.equal(assistantText({
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Final" }],
	}), "Final");
	assert.equal(assistantText({
		role: "assistant",
		stopReason: "aborted",
		content: [{ type: "text", text: "partial" }],
	}), undefined);
	const chunks = splitDiscordText("a".repeat(4_100));
	assert.equal(chunks.join(""), "a".repeat(4_100));
	assert.ok(chunks.every((chunk) => chunk.length <= 1_900));
	const interactivePrefix = "──────────── 👨‍💻 ────────────\n";
	const interactiveSuffix = "\n──────────────────────────────";
	const framedInteractive = (body) => `${interactivePrefix}${body}${interactiveSuffix}`;
	const interactiveBodies = (messages) => messages.map((message) => message.slice(interactivePrefix.length, -interactiveSuffix.length));
	assert.deepEqual(interactiveUserChunks("ordinary input"), [framedInteractive("ordinary input")]);
	assert.deepEqual(interactiveUserChunks("line one\nline two"), [framedInteractive("line one\nline two")]);
	assert.deepEqual(
		interactiveUserChunks("**bold** _under_ `code` \\ slash"),
		[framedInteractive("**bold** _under_ `code` \\ slash")],
		"interactive Markdown must remain byte-for-byte unchanged in the frame body",
	);
	assert.deepEqual(interactiveUserChunks(""), []);
	assert.deepEqual(interactiveUserChunks(" \n "), [framedInteractive(" \n ")], "whitespace-only interactive input must be preserved");
	const interactiveCapacity = 1_900 - interactivePrefix.length - interactiveSuffix.length;
	assert.equal(interactiveCapacity, 1_837);
	assert.equal(interactiveUserChunks("a".repeat(interactiveCapacity))[0].length, 1_900);
	const boundaryUnicodeInput = `${"a".repeat(interactiveCapacity - 1)}😀b`;
	const boundaryUnicodeChunks = interactiveUserChunks(boundaryUnicodeInput);
	assert.equal(boundaryUnicodeChunks.length, 2);
	assert.ok(boundaryUnicodeChunks.every((chunk) => chunk.length <= 1_900));
	assert.equal(interactiveBodies(boundaryUnicodeChunks).join(""), boundaryUnicodeInput, "UTF-16 surrogate pairs must remain intact across chunks");
	assert.doesNotMatch(interactiveBodies(boundaryUnicodeChunks)[0], /[\uD800-\uDBFF]$/);
	assert.doesNotMatch(interactiveBodies(boundaryUnicodeChunks)[1], /^[\uDC00-\uDFFF]/);
	assert.throws(() => interactiveUserChunks("x", interactivePrefix.length + interactiveSuffix.length + 1), /between 65 and 2000/);
	const longInteractiveInput = "long *markdown* line\n".repeat(300);
	const longInteractiveChunks = interactiveUserChunks(longInteractiveInput);
	assert.ok(longInteractiveChunks.length > 1);
	assert.ok(longInteractiveChunks.every((chunk) => chunk.startsWith(interactivePrefix) && chunk.endsWith(interactiveSuffix) && chunk.length <= 1_900));
	assert.equal(interactiveBodies(longInteractiveChunks).join(""), longInteractiveInput);

	const resolvedRegistrationFrame = {
		type: "register",
		token: "token",
		clientId: "client",
		generation: "generation",
		configFingerprint: "fingerprint",
		configEpoch: 1,
		cwd: canonicalMainCheckout,
		projectIdentityResolved: true,
		sessionId: "session",
	};
	assert.equal(isClientFrame(resolvedRegistrationFrame), true);
	assert.equal(isClientFrame({ ...resolvedRegistrationFrame, projectIdentityResolved: "true" }), false);
	const previousValidator = (frame) => frame?.type === "outbound" && typeof frame.requestId === "string" &&
		typeof frame.messageId === "string" && typeof frame.text === "string" && (frame.kind === "user" || frame.kind === "assistant");
	compatibilityDirectory = await mkdtemp(join(tmpdir(), "dc-ipc-"));
	const compatibilityPaths = relayPaths(compatibilityDirectory);
	const previousHostFrames = [];
	let rejectOutbound = false;
	const compatibilityServer = createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (data) => {
			buffer += data;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line) {
					const frame = JSON.parse(line);
					if (frame.type === "register") {
						socket.write(`${JSON.stringify({ type: "registered", channelId: "compat-channel", threadId: "compat-thread", leaderPid: process.pid })}\n`);
					} else if (frame.type === "outbound") {
						previousHostFrames.push(frame);
						if (!previousValidator(frame)) {
							socket.write(`${JSON.stringify({ type: "error", message: "Invalid local Discord relay IPC frame" })}\n`);
						} else if (rejectOutbound) {
							socket.write(`${JSON.stringify({ type: "error", message: "injected correlated rejection", requestId: frame.requestId })}\n`);
						} else {
							socket.write(`${JSON.stringify({ type: "outbound_queued", requestId: frame.requestId, messageId: frame.messageId })}\n`);
						}
					} else if (frame.type === "unregister") socket.end();
				}
				newline = buffer.indexOf("\n");
			}
		});
	});
	await new Promise((resolveListen, rejectListen) => {
		compatibilityServer.once("error", rejectListen);
		compatibilityServer.listen(compatibilityPaths.socket, resolveListen);
	});
	const compatibilityErrors = [];
	const compatibilityClient = new LocalRelayClient(
		{ token: "token", guildId: "12345", epoch: 1 },
		{ cwd: "/compatibility", sessionId: "compatibility-session" },
		{
			onInbound() {},
			onError(error) { compatibilityErrors.push(error); },
			onStatus() {},
		},
		{ paths: compatibilityPaths, launchRelay: async () => {} },
	);
	await compatibilityClient.start();
	compatibilityClient.updateLifecycle("compatibility-inbound", "thinking");
	await compatibilityClient.sendInteractiveUserText("hot **reload**");
	assert.equal(previousHostFrames.length, 1);
	assert.equal(previousHostFrames[0].kind, "user", "interactive presentation must retain the pre-7c01263 outbound kind");
	assert.equal(previousHostFrames[0].text, interactiveUserChunks("hot **reload**")[0]);
	assert.equal(previousValidator(previousHostFrames[0]), true);
	assert.equal(isClientFrame(previousHostFrames[0]), true);
	assert.equal(isClientFrame({ ...previousHostFrames[0], kind: "interactive" }), false, "unknown outbound kinds must remain invalid");
	assert.equal(compatibilityErrors.length, 0);
	rejectOutbound = true;
	const rejectionStarted = Date.now();
	await assert.rejects(() => compatibilityClient.sendUserText("reject once"), /injected correlated rejection/);
	assert.ok(Date.now() - rejectionStarted < 1_000, "correlated request failures must reject without the 30s request timeout");
	assert.equal(previousHostFrames.filter((frame) => frame.text === "reject once").length, 1, "declared request failures must not retry forever");
	await compatibilityClient.stop();
	await new Promise((resolveClose) => compatibilityServer.close(resolveClose));
	await rm(compatibilityDirectory, { recursive: true, force: true });
	compatibilityDirectory = undefined;

	class SlowSocket extends EventEmitter {
		destroyed = false;
		writes = [];
		writable = false;
		write(data) {
			this.writes.push(data);
			return this.writable;
		}
	}
	const slowSocket = new SlowSocket();
	let capacitySignals = 0;
	const boundedWriter = new BoundedSocketWriter(slowSocket, () => { capacitySignals++; });
	assert.equal(boundedWriter.write("initial\n"), true);
	assert.equal(boundedWriter.writeBestEffort("lifecycle\n"), false, "best-effort IPC must not consume normal queue capacity");
	for (let index = 0; index < MAX_QUEUED_IPC_FRAMES; index++) {
		assert.equal(boundedWriter.write(`queued-${index}\n`), true);
	}
	assert.equal(boundedWriter.write("overflow\n"), false, "IPC writer must reject frames beyond its memory cap");
	assert.equal(slowSocket.writes.length, 1, "IPC writer must stop producing while socket.write reports backpressure");
	assert.equal(boundedWriter.queuedFrameCount(), MAX_QUEUED_IPC_FRAMES);
	slowSocket.writable = true;
	slowSocket.emit("drain");
	assert.equal(slowSocket.writes.length, MAX_QUEUED_IPC_FRAMES + 1);
	assert.equal(boundedWriter.queuedFrameCount(), 0);
	assert.equal(capacitySignals, 1, "IPC delivery must resume only after drain");
	boundedWriter.close();

	const apiMessages = Array.from({ length: 250 }, (_, index) => ({
		id: String(index + 1),
		channelId: "pagination-thread",
		content: `message-${index + 1}`,
		authorBot: false,
	}));
	const paginationCalls = [];
	const paginated = await collectChronologicalMessages(async (options) => {
		paginationCalls.push(options);
		return apiMessages
			.filter((message) => options.after ? BigInt(message.id) > BigInt(options.after) : true)
			.filter((message) => options.before ? BigInt(message.id) < BigInt(options.before) : true)
			.sort((left, right) => Number(right.id) - Number(left.id))
			.slice(0, options.limit);
	}, "100");
	assert.deepEqual(paginated.map((message) => message.id), Array.from({ length: 150 }, (_, index) => String(index + 101)));
	assert.deepEqual(paginationCalls.map(({ after, before }) => ({ after, before })), [
		{ after: "100", before: undefined },
		{ after: undefined, before: "151" },
	]);

	const namingStateFile = join(dataDir, "channel-naming-state.json");
	const firstNamingStore = new DiscordStateStore(namingStateFile);
	const allocatedNames = new Map();
	await Promise.all([
		firstNamingStore.resolveProjectChannel("/workspace/one/shared", async (request) => {
			allocatedNames.set("/workspace/one/shared", request.name);
			return "shared-channel-one";
		}),
		new DiscordStateStore(namingStateFile).resolveProjectChannel("/workspace/two/shared", async (request) => {
			allocatedNames.set("/workspace/two/shared", request.name);
			return "shared-channel-two";
		}),
	]);
	assert.equal(new Set(allocatedNames.values()).size, 2, "same-basename projects need distinct allocations");
	assert.ok([...allocatedNames.values()].includes("shared"), "the first race-safe mapping keeps the clean basename");
	for (const [cwd, name] of allocatedNames) {
		if (name !== "shared") assert.equal(name, collidingProjectChannelName(cwd));
	}
	const persistedNames = (await firstNamingStore.load()).projects;
	const restartedNames = new Map();
	await new DiscordStateStore(namingStateFile).resolveProjectChannel("/workspace/one/shared", async (request) => {
		restartedNames.set("/workspace/one/shared", request.name);
		return request.existingChannelId;
	});
	await new DiscordStateStore(namingStateFile).resolveProjectChannel("/workspace/two/shared", async (request) => {
		restartedNames.set("/workspace/two/shared", request.name);
		return request.existingChannelId;
	});
	assert.equal(restartedNames.get("/workspace/one/shared"), persistedNames["/workspace/one/shared"].name);
	assert.equal(restartedNames.get("/workspace/two/shared"), persistedNames["/workspace/two/shared"].name);
	let fallbackName;
	await firstNamingStore.resolveProjectChannel("/workspace/项目", async (request) => {
		fallbackName = request.name;
		return "fallback-channel";
	});
	assert.equal(fallbackName, "project");
	let canonicalName;
	await firstNamingStore.resolveProjectChannel("/workspace/canonical/../canonical/unique", async (request) => {
		canonicalName = request.name;
		return "canonical-channel";
	});
	assert.equal(canonicalName, "unique");
	assert.ok((await firstNamingStore.load()).projects["/workspace/canonical/unique"], "absolute normalized cwd remains the mapping identity");
	const cursorState = new DiscordStateStore(join(dataDir, "cursor-state.json"));
	await cursorState.resolveProjectChannel("/cursor", async () => "cursor-channel");
	await cursorState.resolveSessionThread("cursor-session", "/cursor", "cursor-channel", async () => "cursor-thread");
	await cursorState.recordDiscordMessage("cursor-session", {
		id: "100",
		channelId: "cursor-thread",
		content: "",
		authorBot: true,
	});
	FakeGateway.catchUpByThread.set(
		"cursor-thread",
		apiMessages.slice(100).map((message) => ({ ...message, channelId: "cursor-thread" })),
	);
	const persistCursorMessage = cursorState.recordDiscordMessage.bind(cursorState);
	cursorState.recordDiscordMessage = async (sessionId, message) => {
		if (message.id === "102") throw new Error("injected cursor persistence failure");
		return persistCursorMessage(sessionId, message);
	};
	const cursorCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		cursorState,
		new FakeGateway(),
	);
	await cursorCore.start();
	await assert.rejects(
		() => cursorCore.prepareRegistration("cursor-client", "cursor-generation", {
			cwd: "/cursor",
			sessionId: "cursor-session",
		}),
		/injected cursor persistence failure/,
	);
	assert.equal((await new DiscordStateStore(join(dataDir, "cursor-state.json")).getSession("cursor-session")).threadCursors["cursor-thread"], "101");
	await cursorCore.stop();
	FakeGateway.catchUpByThread.delete("cursor-thread");

	const electionPaths = relayPaths(join(dataDir, "election"));
	const contenders = await Promise.all([
		tryAcquireLeader(electionPaths),
		tryAcquireLeader(electionPaths),
		tryAcquireLeader(electionPaths),
	]);
	const winningLeases = contenders.filter(Boolean);
	assert.equal(winningLeases.length, 1, "atomic leader contention must produce exactly one winner");
	const liveLease = winningLeases[0];
	assert.equal(await tryAcquireLeader(electionPaths, {
		lookupProcessIdentity: async () => undefined,
		probeRelay: async () => true,
	}), undefined, "failed process inspection must not steal a live relay lease");
	assert.equal(await liveLease.heartbeat(), true, "inconclusive inspection must leave the prior owner unfenced");
	await liveLease.release();
	await writeFile(electionPaths.leaderLock, JSON.stringify({
		pid: process.pid,
		nonce: "stale-reused-pid",
		createdAt: 1,
		processIdentity: "unrelated-process-with-reused-pid",
	}));
	assert.equal(await tryAcquireLeader(electionPaths), undefined, "first stale-owner pass performs guarded recovery");
	const recoveredLease = await tryAcquireLeader(electionPaths);
	assert.ok(recoveredLease, "next contender must acquire after stale-owner recovery");
	await recoveredLease.release();

	const fencedPaths = relayPaths(join(dataDir, "fenced-election"));
	const fencedLease = await tryAcquireLeader(fencedPaths);
	assert.ok(fencedLease);
	const expired = new Date(Date.now() - 10_000);
	await utimes(fencedPaths.leaderLock, expired, expired);
	assert.equal(await tryAcquireLeader(fencedPaths, {
		lookupProcessIdentity: async () => undefined,
		probeRelay: async () => false,
	}), undefined, "a live but uninspectable owner must never be replaced merely for unresponsiveness");
	assert.equal(await fencedLease.heartbeat(), true);
	await fencedLease.release();

	const restartPaths = relayPaths(join(dataDir, "restart-ownership"));
	const restartLease = await tryAcquireLeader(restartPaths);
	assert.ok(restartLease);
	const restartOwner = JSON.parse(await readFile(restartPaths.leaderLock, "utf8"));
	const signalledPids = [];
	assert.deepEqual(await restartOwnedRelay(restartPaths, process.pid, restartOwner.nonce, {
		lookupProcessIdentity: async () => restartOwner.processIdentity,
		signalProcess: (pid) => signalledPids.push(pid),
	}), { pid: process.pid, nonce: restartOwner.nonce });
	assert.deepEqual(signalledPids, [process.pid], "verified ownership must signal only its exact relay PID");
	await assert.rejects(() => restartOwnedRelay(restartPaths, process.pid, "stale-connected-lease", {
		lookupProcessIdentity: async () => restartOwner.processIdentity,
		signalProcess: () => assert.fail("stale lease evidence must not signal"),
	}), /lease changed after this client connected/);
	await restartLease.release();

	const missingRestartPaths = relayPaths(join(dataDir, "missing-restart-ownership"));
	await assert.rejects(() => restartOwnedRelay(missingRestartPaths, process.pid, undefined, {
		lookupProcessIdentity: async () => "unused",
		signalProcess: () => assert.fail("missing ownership must not signal"),
	}), /ownership record .* is missing/);
	await mkdir(missingRestartPaths.directory, { recursive: true });
	await writeFile(missingRestartPaths.leaderLock, "{oops");
	await assert.rejects(() => restartOwnedRelay(missingRestartPaths, process.pid, undefined, {
		lookupProcessIdentity: async () => "unused",
		signalProcess: () => assert.fail("malformed ownership must not signal"),
	}), /ownership record .* is malformed/);

	const inaccessibleRestartPaths = relayPaths(join(dataDir, "inaccessible-restart-ownership"));
	await mkdir(inaccessibleRestartPaths.leaderLock, { recursive: true });
	await assert.rejects(() => restartOwnedRelay(inaccessibleRestartPaths, process.pid, undefined, {
		lookupProcessIdentity: async () => "unused",
		signalProcess: () => assert.fail("inaccessible ownership must not signal"),
	}), /ownership record .* cannot be read/);

	const reusedRestartPaths = relayPaths(join(dataDir, "reused-restart-ownership"));
	await mkdir(reusedRestartPaths.directory, { recursive: true });
	await writeFile(reusedRestartPaths.leaderLock, JSON.stringify({
		pid: process.pid,
		nonce: "prior-package-lease",
		createdAt: 1,
		processIdentity: "prior-relay-process",
	}));
	await assert.rejects(() => restartOwnedRelay(reusedRestartPaths, process.pid, "prior-package-lease", {
		lookupProcessIdentity: async () => "reused-unrelated-process",
		signalProcess: () => assert.fail("a reused PID must not be signalled"),
	}), /PID .* was reused by another process/);
	await assert.rejects(() => restartOwnedRelay(reusedRestartPaths, process.pid + 1, undefined, {
		lookupProcessIdentity: async () => "prior-relay-process",
		signalProcess: () => assert.fail("changed ownership must not signal"),
	}), /ownership changed from connected PID/);

	const remapState = new DiscordStateStore(join(dataDir, "remap-state.json"));
	await remapState.resolveProjectChannel("/old", async () => "old-channel");
	await remapState.resolveSessionThread("remapped-session", "/old", "old-channel", async () => "old-thread");
	await remapState.recordDiscordMessage("remapped-session", {
		id: "500",
		channelId: "old-thread",
		content: "preserve across remap",
		authorBot: false,
	});
	await remapState.resolveSessionThread("remapped-session", "/new", "new-channel", async () => "new-thread");
	const remapped = await remapState.getSession("remapped-session");
	assert.deepEqual(remapped.pendingMessages, [{ id: "500", content: "preserve across remap" }]);
	assert.equal(remapped.threadCursors["old-thread"], "500");
	assert.equal(remapped.threadCursors["new-thread"], undefined);

	const deletedStateFile = join(dataDir, "deleted-thread-state.json");
	const deletedState = new DiscordStateStore(deletedStateFile);
	const deletedGateway = new FakeGateway();
	let deletedTerminalFailures = 0;
	const deletedCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		deletedState,
		deletedGateway,
		() => { deletedTerminalFailures++; },
	);
	await deletedCore.start();
	const deletedRegistration = { cwd: "/deleted", sessionId: "deleted-session", sessionName: "Deleted" };
	const healthyRegistration = { cwd: "/healthy", sessionId: "healthy-session", sessionName: "Healthy" };
	const deletedPrepared = await deletedCore.prepareRegistration("deleted-client", "deleted-generation-1", deletedRegistration);
	await deletedCore.activateRegistration("deleted-client", "deleted-generation-1", "deleted-session", () => true);
	await deletedCore.prepareRegistration("healthy-client", "healthy-generation", healthyRegistration);
	await deletedCore.activateRegistration("healthy-client", "healthy-generation", "healthy-session", () => true);
	FakeGateway.deletedThreads.add(deletedPrepared.threadId);
	await deletedCore.queueOutbound("deleted-client", "deleted-generation-1", "deleted-session", "deleted-outbound", "assistant", "retarget me");
	await deletedCore.queueOutbound("healthy-client", "healthy-generation", "healthy-session", "healthy-outbound", "assistant", "must progress");
	await waitFor(() => deletedGateway.sent.some((message) => message.text === "must progress"), "other-session outbound progress past a deleted thread");
	assert.equal(deletedTerminalFailures, 0, "deleted thread delivery must not restart the relay");
	assert.ok((await deletedState.getSession("deleted-session")).outboundMessages.some((message) => message.id === "deleted-outbound"));
	deletedCore.unregisterClient("deleted-client", "deleted-generation-1");
	const repaired = await deletedCore.prepareRegistration("deleted-client", "deleted-generation-2", deletedRegistration);
	assert.notEqual(repaired.threadId, deletedPrepared.threadId);
	await deletedCore.activateRegistration("deleted-client", "deleted-generation-2", "deleted-session", () => true);
	await waitFor(() => deletedGateway.sent.some((message) => message.text === "retarget me"), "remapped outbound delivery");
	assert.equal(deletedGateway.sent.filter((message) => message.text === "retarget me").length, 1);
	assert.equal(deletedGateway.sent.find((message) => message.text === "retarget me").channelId, repaired.threadId);
	assert.equal((await deletedState.getSession("deleted-session")).outboundMessages.length, 0);
	FakeGateway.failOnceTexts.add("retry without another event");
	await deletedCore.queueOutbound("deleted-client", "deleted-generation-2", "deleted-session", "retry-outbound", "assistant", "retry without another event");
	await waitFor(() => FakeGateway.sendAttempts.get("retry without another event") === 1, "initial transient outbound failure");
	await deletedCore.queueOutbound("healthy-client", "healthy-generation", "healthy-session", "unrelated-outbound", "assistant", "unrelated healthy traffic");
	await waitFor(() => deletedGateway.sent.some((message) => message.text === "unrelated healthy traffic"), "unrelated healthy outbound progress");
	await waitFor(async () => deletedGateway.sent.some((message) => message.text === "retry without another event") &&
		(await deletedState.getSession("deleted-session")).outboundMessages.length === 0, "automatic transient outbound retry");
	assert.equal(FakeGateway.sendAttempts.get("retry without another event"), 2);
	const retryTimes = FakeGateway.sendAttemptTimes.get("retry without another event");
	assert.ok(retryTimes[1] - retryTimes[0] >= 90, "unrelated traffic must not bypass the 100ms session retry backoff");
	assert.equal(FakeGateway.sendAttempts.get("unrelated healthy traffic"), 1, "healthy sessions must continue progressing");
	FakeGateway.deletedThreads.delete(deletedPrepared.threadId);
	await deletedCore.stop();

	const faultStateFile = join(dataDir, "fault-state.json");
	const faultState = new DiscordStateStore(faultStateFile);
	const faultGateway = new FakeGateway();
	let terminalFailure;
	const faultCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		faultState,
		faultGateway,
		(error) => { terminalFailure = error; },
	);
	await faultCore.start();
	const faultRegistration = { cwd: "/fault", sessionId: "fault-session", sessionName: "Fault session" };
	await faultCore.prepareRegistration("same-client", "generation-1", faultRegistration);
	await faultCore.activateRegistration("same-client", "generation-1", "fault-session", () => {});
	await faultCore.prepareRegistration("same-client", "generation-2", faultRegistration);
	await faultCore.activateRegistration("same-client", "generation-2", "fault-session", () => {});
	faultCore.unregisterClient("same-client", "generation-1");
	const markChunkSent = faultState.markOutboundChunkSent.bind(faultState);
	let failChunkPersistence = true;
	faultState.markOutboundChunkSent = async (...args) => {
		if (failChunkPersistence) {
			failChunkPersistence = false;
			throw new Error("injected crash after Discord accepted chunk");
		}
		return markChunkSent(...args);
	};
	const longOutbound = "x".repeat(4_000);
	await faultCore.queueOutbound("same-client", "generation-2", "fault-session", "stable-outbound-id", "assistant", longOutbound);
	await waitFor(() => terminalFailure, "fault-injected partial Discord send failure");
	await faultCore.stop();
	const retryGateway = new FakeGateway();
	const retryCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		new DiscordStateStore(faultStateFile),
		retryGateway,
	);
	await retryCore.start();
	await retryCore.prepareRegistration("retry-client", "retry-generation", faultRegistration);
	await retryCore.activateRegistration("retry-client", "retry-generation", "fault-session", () => true);
	await waitFor(async () => !(await new DiscordStateStore(faultStateFile).nextOutbound()), "durable outbound retry completion");
	const sentChunks = [...faultGateway.sent, ...retryGateway.sent];
	assert.equal(sentChunks.map((message) => message.text).join(""), longOutbound, "partial retries must send each chunk once");
	assert.equal(new Set(sentChunks.map((message) => message.nonce)).size, sentChunks.length, "chunk nonces must deduplicate retries");
	await retryCore.stop();
	FakeGateway.instances = [];
	FakeGateway.activeConnections = 0;
	FakeGateway.maximumActiveConnections = 0;
	FakeGateway.nonceResults.clear();
	FakeGateway.lifecycleReactions.clear();
	FakeGateway.lifecycleReactionEvents.length = 0;
	FakeGateway.failLifecycleOnce.clear();
	FakeGateway.hangLifecycleFor.clear();

	const relayDirectory = join(dataDir, "shared-relay");
	const paths = relayPaths(relayDirectory);
	const stateFile = join(relayDirectory, "state.json");
	let injectedRestartFailure;
	let requestedRestartPid;
	let requestedRestartNonce;
	const extension = createDiscordExtension({
		paths,
		loadConfig: async () => ({ token: "token", guildId: "12345", categoryId: "67890", epoch: 1 }),
		saveConfig: async () => {},
		createStateStore: () => new DiscordStateStore(stateFile),
		createTransport: () => new FakeGateway(),
		async restartRelay(expectedPid, expectedNonce) {
			requestedRestartPid = expectedPid;
			requestedRestartNonce = expectedNonce;
			if (injectedRestartFailure) throw injectedRestartFailure;
			FakeGateway.instances.at(-1).terminal();
		},
	});
	const first = createExtensionHarness(extension, {
		cwd: "/work/one",
		sessionId: "session-11111111",
		sessionName: "First session",
	});
	await first.emit("session_start", { reason: "startup" });
	assert.equal(await tryAcquireLeader(paths, {
		lookupProcessIdentity: async () => undefined,
	}), undefined, "failed process inspection plus a healthy relay protocol must preserve the live owner");
	const second = createExtensionHarness(extension, {
		cwd: "/work/one",
		sessionId: "session-22222222",
		sessionName: "Second session",
	});
	await second.emit("session_start", { reason: "startup" });
	const taskNamed = createExtensionHarness(extension, {
		cwd: linkedSubdirectory,
		sessionId: "tasktitle-33333333",
		sessionName: "Generic Pi session",
	});
	await taskNamed.emit("session_start", { reason: "startup" });
	const taskNamedMapping = await new DiscordStateStore(stateFile).getSession("tasktitle-33333333");
	const taskThreadName = sessionThreadName("tasktitle-33333333", "Implement task-title thread naming");
	assert.ok(FakeGateway.instances[0].threadRequests.some((request) => request.name === taskThreadName), "explicit worktree task title must override the Pi session name at registration");
	await writeFile(join(linkedWorktree, "TASK.md"), "# A changed task title must not rename an existing thread\n");
	await taskNamed.runCommand("discord", "reconnect");
	assert.equal(
		(await new DiscordStateStore(stateFile).getSession("tasktitle-33333333")).threadId,
		taskNamedMapping.threadId,
		"rediscovered task titles must not rename an existing session thread",
	);
	assert.equal(FakeGateway.instances.length, 1, "concurrent Pi clients must share one Discord gateway");
	assert.equal(FakeGateway.activeConnections, 1);
	assert.equal(FakeGateway.maximumActiveConnections, 1);
	if (process.platform !== "win32") {
		assert.equal((await stat(paths.directory)).mode & 0o777, 0o700, "relay directory must be private");
		assert.equal((await stat(paths.authToken)).mode & 0o777, 0o600, "relay token must be private");
		assert.equal((await stat(paths.socket)).mode & 0o777, 0o600, "relay socket must be private");
	}
	assert.deepEqual([...first.commands.keys()], ["discord"]);
	assert.ok(first.events.has("agent_settled"));
	assert.ok(first.events.has("agent_end"));
	assert.ok(first.events.has("tool_execution_start"));

	assert.deepEqual(first.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "💬"]);
	assert.deepEqual(second.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "💬"]);
	assert.deepEqual(taskNamed.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "💬"]);
	assert.ok(FakeGateway.instances[0].threadRequests.some(
		(request) => request.name === sessionThreadName("session-11111111", "First session"),
	), "absent task metadata must preserve the Pi session name");
	const firstMapping = await new DiscordStateStore(stateFile).getSession("session-11111111");
	const secondMapping = await new DiscordStateStore(stateFile).getSession("session-22222222");
	const { channelId: firstChannel, threadId: firstThread } = firstMapping;
	const { channelId: secondChannel, threadId: secondThread } = secondMapping;
	assert.equal(firstChannel, secondChannel, "sessions in one cwd must share its durable project channel");
	assert.notEqual(firstThread, secondThread);
	await first.runCommand("discord", "status");
	assert.match(first.notifications.at(-1)[0], new RegExp(`Project channel: ${firstChannel}\\nSession thread: ${firstThread}$`), "command status must retain detailed diagnostics");
	assert.ok(first.commands.get("discord").getArgumentCompletions("r").some(({ value }) => value === "restart"));
	let gateway = FakeGateway.instances[0];
	const gatewayCountBeforeClientReconnect = FakeGateway.instances.length;
	await first.runCommand("discord", "reconnect");
	assert.equal(FakeGateway.instances.length, gatewayCountBeforeClientReconnect, "/discord reconnect must not replace the shared relay");
	injectedRestartFailure = new Error("Discord relay ownership record is malformed");
	await first.runCommand("discord", "restart");
	assert.deepEqual(first.notifications.at(-1), ["Discord relay restart failed: Discord relay ownership record is malformed", "error"]);
	assert.equal(gateway.connected, true, "failed restart verification must leave the relay untouched");
	injectedRestartFailure = undefined;
	second.setIdle(false);
	const routedSecond = second.nextUserMessage();
	await gateway.emit({ id: "10", channelId: secondThread, content: "route to second", authorBot: false });
	const routedSecondMessage = await routedSecond;
	assert.equal(stripInboundMarker(routedSecondMessage.text), "route to second");
	assert.equal(inboundMessageId(routedSecondMessage.text), "10");
	assert.deepEqual(routedSecondMessage.options, { deliverAs: "followUp" });
	const contextResult = await second.emit("context", {
		messages: [{ role: "user", content: [{ type: "text", text: routedSecondMessage.text }] }],
	});
	assert.equal(contextResult.messages[0].content[0].text, "route to second", "inbound receipt marker must not reach the model");
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: routedSecondMessage.text }] } });
	await waitFor(() => second.entries.some((entry) => entry.data?.messageId === "10"), "durable Pi acceptance receipt");
	assert.equal(first.userMessages.length, 0, "Discord input must route only to its Pi session");
	await gateway.emit({ id: "10", channelId: secondThread, content: "duplicate", authorBot: false });
	assert.equal(second.userMessages.length, 1, "duplicate Discord IDs must not deliver twice");
	await gateway.emit({ id: "11", channelId: secondThread, content: "bot", authorBot: true });
	assert.equal(second.userMessages.length, 1, "bot output must not loop back into Pi");

	await waitFor(() => FakeGateway.lifecycleReactions.get("10") === "👀", "accepted lifecycle reaction");
	await second.emit("before_agent_start", { prompt: routedSecondMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: routedSecondMessage.text }] } });
	await waitFor(() => FakeGateway.lifecycleReactions.get("10") === "🤔", "thinking lifecycle reaction");
	await second.emit("tool_execution_start", { toolCallId: "tool-10", toolName: "read", args: {} });
	await second.emit("tool_execution_start", { toolCallId: "tool-10-duplicate", toolName: "read", args: {} });
	await waitFor(() => FakeGateway.lifecycleReactions.get("10") === "⚙️", "tool lifecycle reaction");
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	assert.equal(FakeGateway.lifecycleReactions.get("10"), "⚙️", "success must wait for agent_settled");
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("10") === "✅", "settled lifecycle reaction");
	assert.deepEqual(reactionSequence("10"), ["👀", "🤔", "⚙️", "✅"], "duplicate lifecycle events must be idempotent and ordered");

	const toolFreeDelivery = second.nextUserMessage();
	await gateway.emit({ id: "12", channelId: secondThread, content: "tool free", authorBot: false });
	const toolFreeMessage = await toolFreeDelivery;
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: toolFreeMessage.text }] } });
	await second.emit("before_agent_start", { prompt: toolFreeMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: toolFreeMessage.text }] } });
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("12") === "✅", "tool-free settled reaction");
	assert.deepEqual(reactionSequence("12"), ["👀", "🤔", "✅"], "tool-free runs must skip the tool reaction");

	const queuedA = second.nextUserMessage();
	await gateway.emit({ id: "13", channelId: secondThread, content: "queued a", authorBot: false });
	const queuedAMessage = await queuedA;
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: queuedAMessage.text }] } });
	const queuedB = second.nextUserMessage();
	await gateway.emit({ id: "14", channelId: secondThread, content: "queued b", authorBot: false });
	const queuedBMessage = await queuedB;
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: queuedBMessage.text }] } });
	await second.emit("before_agent_start", { prompt: queuedAMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: queuedAMessage.text }] } });
	await second.emit("tool_execution_start", { toolCallId: "tool-13", toolName: "read", args: {} });
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: queuedBMessage.text }] } });
	await second.emit("tool_execution_start", { toolCallId: "tool-14", toolName: "bash", args: {} });
	await waitFor(() => FakeGateway.lifecycleReactions.get("13") === "⚙️" && FakeGateway.lifecycleReactions.get("14") === "⚙️", "queued prompt tool reactions");
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "unrelated local follow-up" }] } });
	const reactionsBeforeLocalTool = reactionSequence("14").length;
	await second.emit("tool_execution_start", { toolCallId: "local-tool", toolName: "read", args: {} });
	await new Promise((resolveWait) => setTimeout(resolveWait, 30));
	assert.equal(reactionSequence("14").length, reactionsBeforeLocalTool, "local follow-up tools must not react to a Discord prompt");
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("13") === "✅" && FakeGateway.lifecycleReactions.get("14") === "✅", "queued prompt terminal reactions");
	assert.deepEqual(reactionSequence("13"), ["👀", "🤔", "⚙️", "✅"]);
	assert.deepEqual(reactionSequence("14"), ["👀", "🤔", "⚙️", "✅"]);

	const localReactionCount = FakeGateway.lifecycleReactionEvents.length;
	await second.emit("before_agent_start", { prompt: "ordinary local prompt" });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "ordinary local prompt" }] } });
	await second.emit("tool_execution_start", { toolCallId: "local-only-tool", toolName: "read", args: {} });
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	assert.equal(FakeGateway.lifecycleReactionEvents.length, localReactionCount, "local/TUI runs must never receive Discord reactions");

	await first.emit("input", { text: "local input", source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === framedInteractive("local input")), "framed interactive user send");
	assert.equal(gateway.sent.at(-1).channelId, firstThread);
	assert.equal(gateway.sent.at(-1).text, framedInteractive("local input"));
	await first.emit("input", { text: "line one\nline two", source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === framedInteractive("line one\nline two")), "framed multiline interactive send");
	await first.emit("input", { text: " \n ", source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === framedInteractive(" \n ")), "framed whitespace-only interactive send");
	const sentBeforeEmptyInput = gateway.sent.length;
	await first.emit("input", { text: "", source: "interactive" });
	assert.equal(gateway.sent.length, sentBeforeEmptyInput, "empty interactive input must not emit a Discord message");
	const markdownInput = "**bold** _under_ `code` \\ slash";
	const markdownOutput = interactiveUserChunks(markdownInput)[0];
	await first.emit("input", { text: markdownInput, source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === markdownOutput), "unchanged interactive Markdown send");
	const longStart = gateway.sent.length;
	await first.emit("input", { text: longInteractiveInput, source: "interactive" });
	await waitFor(() => gateway.sent.length >= longStart + longInteractiveChunks.length, "chunk-safe long interactive send");
	assert.deepEqual(gateway.sent.slice(longStart).map((message) => message.text), longInteractiveChunks);
	await first.emit("input", { text: "RPC input", source: "rpc" });
	await waitFor(() => gateway.sent.some((message) => message.text === "RPC input"), "unchanged non-interactive input send");
	const sentBeforeLoopCheck = gateway.sent.length;
	await first.emit("input", { text: "Discord echo", source: "extension" });
	assert.equal(gateway.sent.length, sentBeforeLoopCheck, "Discord-origin extension input must not loop back to Discord");
	await first.emit("before_agent_start", { prompt: "local assistant mirror" });
	await first.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final only" }] },
	});
	assert.notEqual(gateway.sent.at(-1)?.text, "final only");
	await first.emit("agent_settled", {});
	await waitFor(() => gateway.sent.some((message) => message.text === "final only"), "durable final assistant send");
	assert.equal(gateway.sent.at(-1)?.text, "final only", "assistant output must wait for agent_settled");

	async function runTerminalLifecycle(id, stopReason) {
		const delivery = second.nextUserMessage();
		await gateway.emit({ id, channelId: secondThread, content: `terminal ${id}`, authorBot: false });
		const message = await delivery;
		await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: message.text }] } });
		await waitFor(() => FakeGateway.lifecycleReactions.get(id) === "👀", `${id} accepted reaction`);
		await second.emit("before_agent_start", { prompt: message.text });
		await second.emit("agent_start", {});
		await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: message.text }] } });
		await second.emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
		await second.emit("agent_settled", {});
		await waitFor(() => FakeGateway.lifecycleReactions.get(id) === "❌", `${id} failed reaction`);
	}
	await runTerminalLifecycle("16", "error");
	await runTerminalLifecycle("17", "aborted");
	assert.deepEqual(reactionSequence("16"), ["👀", "🤔", "❌"]);
	assert.deepEqual(reactionSequence("17"), ["👀", "🤔", "❌"]);

	FakeGateway.failLifecycleOnce.add("18:👀");
	const reactionFailureDelivery = second.nextUserMessage();
	await gateway.emit({ id: "18", channelId: secondThread, content: "reaction API failure", authorBot: false });
	const reactionFailureMessage = await reactionFailureDelivery;
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: reactionFailureMessage.text }] } });
	await second.emit("before_agent_start", { prompt: reactionFailureMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: reactionFailureMessage.text }] } });
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("18") === "✅", "progress after reaction API failure");
	assert.equal(stripInboundMarker(reactionFailureMessage.text), "reaction API failure", "reaction failure must not block Pi delivery");
	assert.deepEqual(reactionSequence("18"), ["🤔", "✅"], "later statuses must recover from a reaction API failure");

	const reconnectDelivery = second.nextUserMessage();
	await gateway.emit({ id: "19", channelId: secondThread, content: "survive reconnect", authorBot: false });
	const reconnectMessage = await reconnectDelivery;
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: reconnectMessage.text }] } });
	await second.emit("before_agent_start", { prompt: reconnectMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: reconnectMessage.text }] } });
	await waitFor(() => FakeGateway.lifecycleReactions.get("19") === "🤔", "pre-reconnect thinking reaction");
	const preReconnectGateway = gateway;
	const gatewayCountBeforeReconnect = FakeGateway.instances.length;
	FakeGateway.lifecycleReactions.delete("19");
	await second.runCommand("discord", "restart");
	assert.equal(requestedRestartPid, process.pid);
	assert.equal(typeof requestedRestartNonce, "string", "current relays must provide authenticated lease evidence");
	assert.match(second.notifications.at(-1)[0], /^Discord relay restarted: PID \d+ replaced by PID \d+$/);
	await waitFor(() => FakeGateway.instances.length > gatewayCountBeforeReconnect, "command relay restart");
	gateway = FakeGateway.instances.at(-1);
	await waitFor(() => FakeGateway.lifecycleReactionEvents.some((event) =>
		event.messageId === "19" && event.reaction === "🤔" && event.gateway === gateway), "lifecycle replay after reconnect");
	assert.notEqual(gateway, preReconnectGateway);
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("19") === "✅", "post-reconnect settled reaction");

	const failedInjection = createExtensionHarness(extension, {
		cwd: "/work/failing",
		sessionId: "session-44444444",
		sessionName: "Failing injection",
	});
	await failedInjection.emit("session_start", { reason: "startup" });
	const failedThread = (await new DiscordStateStore(stateFile).getSession("session-44444444")).threadId;
	failedInjection.setInjectionError(true);
	FakeGateway.hangLifecycleFor.add("15:👀");
	await gateway.emit({ id: "15", channelId: failedThread, content: "must remain pending", authorBot: false });
	await waitFor(() => failedInjection.notifications.some(([text]) => text.includes("injected Pi acceptance failure")), "Pi injection failure");
	assert.deepEqual(failedInjection.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "⚠️"]);
	assert.equal(failedInjection.userMessages.length, 0);
	const shutdownStarted = Date.now();
	await failedInjection.emit("session_shutdown", { reason: "quit" });
	assert.ok(Date.now() - shutdownStarted < 2_500, "unconfirmed inbound must not block shutdown");
	const failedState = await new DiscordStateStore(stateFile).getSession("session-44444444");
	assert.deepEqual(failedState.pendingMessages, [{ id: "15", content: "must remain pending" }]);
	const retriedInjection = createExtensionHarness(extension, {
		cwd: "/work/failing",
		sessionId: "session-44444444",
		sessionName: "Failing injection",
	});
	const retriedDelivery = retriedInjection.nextUserMessage();
	await retriedInjection.emit("session_start", { reason: "resume" });
	const retriedMessage = await retriedDelivery;
	assert.equal(stripInboundMarker(retriedMessage.text), "must remain pending");
	await retriedInjection.emit("message_end", { message: { role: "user", content: [{ type: "text", text: retriedMessage.text }] } });
	await waitFor(() => retriedInjection.entries.some((entry) => entry.data?.messageId === "15"), "retried Pi acceptance receipt");
	await retriedInjection.emit("session_shutdown", { reason: "quit" });

	await first.emit("session_shutdown", { reason: "quit" });
	assert.equal(gateway.connected, true, "relay child must survive the Pi client that launched it");
	assert.equal(FakeGateway.activeConnections, 1);
	assert.equal(FakeGateway.maximumActiveConnections, 1);
	const failoverGateway = gateway;
	const afterFailover = second.nextUserMessage();
	await failoverGateway.emit({ id: "20", channelId: secondThread, content: "after failover", authorBot: false });
	const afterFailoverMessage = await afterFailover;
	assert.equal(stripInboundMarker(afterFailoverMessage.text), "after failover");
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: afterFailoverMessage.text }] } });
	await waitFor(() => second.entries.some((entry) => entry.data?.messageId === "20"), "post-failover Pi acceptance receipt");

	const inactive = createExtensionHarness(extension, {
		cwd: "/work/inactive",
		sessionId: "session-33333333",
		sessionName: "Inactive session",
	});
	await inactive.emit("session_start", { reason: "startup" });
	const inactiveThread = (await new DiscordStateStore(stateFile).getSession("session-33333333")).threadId;
	await inactive.emit("session_shutdown", { reason: "quit" });
	await failoverGateway.emit({ id: "30", channelId: inactiveThread, content: "queued while inactive", authorBot: false });
	assert.equal(inactive.userMessages.length, 0);
	const resumed = createExtensionHarness(extension, {
		cwd: "/work/inactive",
		sessionId: "session-33333333",
		sessionName: "Inactive session",
	});
	const queuedDelivery = resumed.nextUserMessage();
	await resumed.emit("session_start", { reason: "resume" });
	const queuedMessage = await queuedDelivery;
	assert.equal(stripInboundMarker(queuedMessage.text), "queued while inactive", "inactive-session messages must queue durably");
	await resumed.emit("message_end", { message: { role: "user", content: [{ type: "text", text: queuedMessage.text }] } });
	await waitFor(() => resumed.entries.some((entry) => entry.data?.messageId === "30"), "queued Pi acceptance receipt");
	await resumed.emit("session_shutdown", { reason: "quit" });

	await taskNamed.emit("session_shutdown", { reason: "quit" });
	await second.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => FakeGateway.activeConnections === 0, "zero-client relay child shutdown");
	FakeGateway.catchUpByThread.set(inactiveThread, [
		{ id: "30", channelId: inactiveThread, content: "old duplicate", authorBot: false },
		{ id: "40", channelId: inactiveThread, content: "missed while offline", authorBot: false },
	]);
	const restarted = createExtensionHarness(extension, {
		cwd: "/work/inactive",
		sessionId: "session-33333333",
		sessionName: "Inactive session",
	});
	const catchUpDelivery = restarted.nextUserMessage();
	await restarted.emit("session_start", { reason: "resume" });
	const catchUpMessage = await catchUpDelivery;
	assert.equal(stripInboundMarker(catchUpMessage.text), "missed while offline", "relay restart must fetch after the durable cursor");
	await restarted.emit("message_end", { message: { role: "user", content: [{ type: "text", text: catchUpMessage.text }] } });
	await waitFor(() => restarted.entries.some((entry) => entry.data?.messageId === "40"), "catch-up Pi acceptance receipt");
	assert.equal(restarted.userMessages.length, 1, "catch-up must not redeliver acknowledged Discord messages");
	await restarted.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => FakeGateway.activeConnections === 0, "restarted zero-client relay shutdown");

	const persisted = JSON.parse(await readFile(stateFile, "utf8"));
	assert.equal(persisted.sessions["session-33333333"].pendingMessages.length, 0);
	assert.equal(persisted.sessions["session-33333333"].threadCursors[inactiveThread], "40");
	assert.equal(FakeGateway.maximumActiveConnections, 1);

	const rolloverDirectory = join(dataDir, "rollover-relay");
	const rolloverStateFile = join(rolloverDirectory, "state.json");
	const rolloverDependencies = (config) => ({
		paths: relayPaths(rolloverDirectory),
		loadConfig: async () => config,
		saveConfig: async () => {},
		createStateStore: () => new DiscordStateStore(rolloverStateFile),
		createTransport: () => new FakeGateway(),
	});
	const rolloverA = createExtensionHarness(createDiscordExtension(rolloverDependencies(environmentFirst)), {
		cwd: "/rollover",
		sessionId: "rollover-a",
		sessionName: "Rollover A",
	});
	await rolloverA.emit("session_start", { reason: "startup" });
	const beforeRolloverCount = FakeGateway.instances.length;
	const rolloverB = createExtensionHarness(createDiscordExtension(rolloverDependencies(environmentSecond)), {
		cwd: "/rollover",
		sessionId: "rollover-b",
		sessionName: "Rollover B",
	});
	await rolloverB.emit("session_start", { reason: "startup" });
	await waitFor(
		() => FakeGateway.instances.length > beforeRolloverCount && FakeGateway.instances.at(-1).config?.token === "environment-two" &&
			rolloverA.statuses.at(-1)?.[1] === "💬" && rolloverB.statuses.at(-1)?.[1] === "💬",
		"atomic config epoch rollover with stale-client convergence",
	);
	assert.equal(FakeGateway.activeConnections, 1);
	assert.equal(FakeGateway.maximumActiveConnections, 1);
	const beforeTerminalCount = FakeGateway.instances.length;
	FakeGateway.instances.at(-1).terminal();
	await waitFor(() => rolloverA.statuses.some(([, text]) => text === "🔄") || rolloverB.statuses.some(([, text]) => text === "🔄"), "compact reconnecting status");
	await waitFor(() => FakeGateway.instances.length > beforeTerminalCount, "terminal gateway replacement");
	await waitFor(() => rolloverA.statuses.at(-1)?.[1] === "💬" && rolloverB.statuses.at(-1)?.[1] === "💬", "compact reconnected statuses");
	assert.equal(FakeGateway.activeConnections, 1);
	assert.equal(FakeGateway.maximumActiveConnections, 1);
	await rolloverB.emit("session_shutdown", { reason: "quit" });
	assert.equal(FakeGateway.activeConnections, 1, "newest-config relay must survive its introducing client");
	assert.equal(rolloverA.statuses.at(-1)?.[1], "💬");
	await rolloverA.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => FakeGateway.activeConnections === 0, "rollover relay shutdown");
	for (const harness of [first, second, taskNamed, failedInjection, retriedInjection, inactive, resumed, restarted, rolloverA, rolloverB]) {
		for (const [key, text] of harness.statuses) {
			assert.equal(key, PACKAGE_FOOTER_STATUS_KEYS.discord);
			assert.ok(text === undefined || text === "💬" || text === "🔄" || text === "⚠️", `footer status must be compact: ${text}`);
		}
	}

	console.log("[discord bridge test] passed");
} finally {
	if (compatibilityDirectory) await rm(compatibilityDirectory, { recursive: true, force: true });
	await rm(output, { recursive: true, force: true });
	await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
