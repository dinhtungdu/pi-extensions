import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, normalize, parse, sep } from "node:path";
import { normalizeCwd } from "./text.js";

const GIT_IDENTITY_TIMEOUT_MS = 1_000;
const GIT_OUTPUT_LIMIT_BYTES = 8_192;

export interface ProjectIdentityOptions {
	gitExecutable?: string;
	timeoutMs?: number;
}

export interface ProjectContext {
	projectIdentity: string;
	checkoutRoot: string;
}

function gitEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const name of [
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_CEILING_DIRECTORIES",
		"GIT_COMMON_DIR",
		"GIT_CONFIG",
		"GIT_CONFIG_COUNT",
		"GIT_CONFIG_PARAMETERS",
		"GIT_DIR",
		"GIT_DISCOVERY_ACROSS_FILESYSTEM",
		"GIT_GRAFT_FILE",
		"GIT_IMPLICIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_NO_REPLACE_OBJECTS",
		"GIT_OBJECT_DIRECTORY",
		"GIT_PREFIX",
		"GIT_REPLACE_REF_BASE",
		"GIT_SHALLOW_FILE",
		"GIT_WORK_TREE",
	]) delete environment[name];
	for (const name of Object.keys(environment)) {
		if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete environment[name];
	}
	return environment;
}

function runGit(cwd: string, argument: "--git-common-dir" | "--show-toplevel", options: ProjectIdentityOptions): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		execFile(
			options.gitExecutable ?? "git",
			["-C", cwd, "rev-parse", "--path-format=absolute", argument],
			{
				encoding: "utf8",
				env: gitEnvironment(),
				maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
				timeout: options.timeoutMs ?? GIT_IDENTITY_TIMEOUT_MS,
				windowsHide: true,
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolveOutput(stdout);
			},
		);
	});
}

function absoluteGitPath(output: string): string | undefined {
	const lines = output.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	if (lines.length !== 1 || !lines[0] || lines[0].includes("\0") || !isAbsolute(lines[0])) return undefined;
	return normalize(lines[0]);
}

function isNestedGitMetadata(path: string): boolean {
	const { root } = parse(path);
	return path.slice(root.length).split(sep).includes(".git");
}

/**
 * Resolve stable project and checkout identities without making Git
 * availability a bridge requirement. Normal checkouts and linked worktrees
 * share their common .git directory while retaining distinct checkout roots.
 */
export async function resolveProjectContext(cwd: string, options: ProjectIdentityOptions = {}): Promise<ProjectContext> {
	const fallback = normalizeCwd(cwd);
	const [commonResult, topLevelResult] = await Promise.allSettled([
		runGit(fallback, "--git-common-dir", options),
		runGit(fallback, "--show-toplevel", options),
	]);
	const commonDirectory = commonResult.status === "fulfilled" ? absoluteGitPath(commonResult.value) : undefined;
	const topLevel = topLevelResult.status === "fulfilled" ? absoluteGitPath(topLevelResult.value) : undefined;
	if (!commonDirectory) return { projectIdentity: fallback, checkoutRoot: topLevel ?? fallback };
	const projectIdentity = basename(commonDirectory) === ".git"
		? dirname(commonDirectory)
		: isNestedGitMetadata(commonDirectory)
			? topLevel ?? fallback
			: commonDirectory;
	return {
		projectIdentity,
		checkoutRoot: topLevel ?? commonDirectory,
	};
}

export async function resolveProjectIdentity(cwd: string, options: ProjectIdentityOptions = {}): Promise<string> {
	return (await resolveProjectContext(cwd, options)).projectIdentity;
}
