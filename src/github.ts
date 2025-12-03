import JSZip from "jszip";

// Custom error to carry HTTP status from GitHub fetch failures
export class GitHubFetchError extends Error {
  status: number;
  constructor(status: number, statusText: string) {
    super(`Failed to fetch repository: ${status} ${statusText}`);
    this.status = status;
  }
}

// 定数
const MAX_DISPLAY_FILE_SIZE = 30 * 1024; // 30KB

// GitHubリポジトリのZIPファイルを取得
export async function fetchZip(owner: string, repo: string, branch: string, token?: string | null) {
  const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/${branch}`;
  console.log(`📦 Fetching zip from: ${zipUrl}`);

  const headers: Record<string, string> = {
    "User-Agent": "Pera1-Bot",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  return await fetch(zipUrl, { headers });
}

// 既存のGitHub処理ロジックを関数として抽出
export async function processGitHubRepository(
  params: any,
  githubAccessToken?: string | null,
): Promise<string> {
  const { url, dir, ext, branch: paramBranch, file: queryFile, mode } = params;

  let parsed: URL;
  try {
    parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
  } catch (error) {
    throw new Error(`Invalid URL: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error("Invalid GitHub repository URL format");
  }

  const owner = segments[0];
  const repo = segments[1];
  const pathSegments = segments.slice(2);

  // Extract branch and path info embedded in the URL (e.g. /tree/<branch>/<path> or /blob/<branch>/<file>)
  let pathBranch: string | undefined;
  let pathTargetDirs: string[] = [];
  let pathTargetFile: string | undefined;

  if (pathSegments.length >= 2) {
    const typeSegment = pathSegments[0];
    if (typeSegment === "tree") {
      pathBranch = pathSegments[1];
      const remainingPath = pathSegments.slice(2).join("/");
      if (remainingPath) {
        pathTargetDirs = [remainingPath.endsWith("/") ? remainingPath : `${remainingPath}/`];
      }
    } else if (typeSegment === "blob" && pathSegments.length >= 3) {
      pathBranch = pathSegments[1];
      const filePath = pathSegments.slice(2).join("/");
      if (filePath) {
        pathTargetFile = filePath;
      }
    }
  }

  // Fallback: extra path segments without /tree or /blob mean directory scope (e.g. /owner/repo/src/utils)
  if (!pathBranch && !pathTargetFile && pathTargetDirs.length === 0 && pathSegments.length > 0) {
    const scopePath = pathSegments.join("/");
    if (scopePath) {
      pathTargetDirs = [scopePath.endsWith("/") ? scopePath : `${scopePath}/`];
    }
  }

  // パラメータの処理
  const queryDirs = dir
    ?.split(",")
    .map((d: string) => d.trim())
    .filter((d: string) => d);
  const queryExts = ext
    ?.split(",")
    .map((e: string) => e.trim().toLowerCase())
    .filter((e: string) => e);
  const isTreeMode = mode === "tree";

  // Branch: query parameter has highest priority, then path-embedded branch, finally main
  let branch = paramBranch || pathBranch || "main";

  const baseDir = pathTargetDirs[0] || "";
  const normalizeDir = (d: string) => {
    const trimmed = d.replace(/^\/+/, "");
    const withSlash = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    if (!baseDir) return withSlash;
    if (withSlash.startsWith(baseDir)) return withSlash;
    return baseDir + withSlash;
  };

  // Directory / file filters: query params override path-embedded filters but remain relative to the path selection
  let finalTargetDirs: string[] = [];
  if (queryDirs && queryDirs.length > 0) {
    finalTargetDirs = queryDirs.map(normalizeDir);
  } else if (pathTargetDirs.length > 0) {
    finalTargetDirs = pathTargetDirs;
  }

  const targetExts = queryExts || [];

  let targetFile: string | undefined;
  if (queryFile) {
    const normalized = queryFile.startsWith("/") ? queryFile.slice(1) : queryFile;
    if (baseDir && !normalized.startsWith(baseDir)) {
      targetFile = baseDir + normalized;
    } else {
      targetFile = normalized;
    }
  } else {
    targetFile = pathTargetFile;
  }

  // ZIP取得
  let zipResp = await fetchZip(owner, repo, branch, githubAccessToken);
  if (!zipResp.ok) {
    // デフォルトブランチへのフォールバック
    const defaultBranches = ["main", "master"];
    let foundBranch = false;
    for (const defaultBranch of defaultBranches) {
      if (branch === defaultBranch) continue;

      const tempResp = await fetchZip(owner, repo, defaultBranch, githubAccessToken);
      if (tempResp.ok) {
        branch = defaultBranch;
        zipResp = tempResp;
        foundBranch = true;
        break;
      }
    }

    if (!foundBranch) {
      throw new GitHubFetchError(zipResp.status, zipResp.statusText);
    }
  }

  const arrayBuffer = await zipResp.arrayBuffer();
  const jszip = await JSZip.loadAsync(arrayBuffer);
  const rootPrefix = `${repo}-${branch}/`;

  // TypeScript プロジェクト判定
  const hasTsConfig = Object.keys(jszip.files).some(
    (name) => name.startsWith(rootPrefix) && name.endsWith("tsconfig.json"),
  );

  const fileTree = new Map<string, { size: number; content: string; isTruncated?: boolean }>();
  let originalTotalSize = 0;
  let displayTotalSize = 0;

  for (const fileObj of Object.values(jszip.files)) {
    if (fileObj.dir) continue;
    if (!fileObj.name.startsWith(rootPrefix)) continue;

    const fileRelative = fileObj.name.slice(rootPrefix.length);

    // ファイルフィルタリング
    if (targetFile) {
      if (fileRelative !== targetFile) continue;
    } else {
      if (!shouldIncludeFile(fileRelative, finalTargetDirs, targetExts)) continue;
    }

    const isReadmeFile = /readme\.md$/i.test(fileRelative);

    if (isTreeMode && !isReadmeFile) {
      fileTree.set(fileRelative, { size: 0, content: "" });
    } else {
      const content = await fileObj.async("string");
      const size = new TextEncoder().encode(content).length;

      if (shouldSkipFile(fileRelative, size, content, hasTsConfig)) {
        continue;
      }

      let isTruncated = false;
      let processedContent = content;
      let displaySize = size;

      if (size > MAX_DISPLAY_FILE_SIZE) {
        processedContent = content.substring(0, MAX_DISPLAY_FILE_SIZE);
        const remainingSize = (size - MAX_DISPLAY_FILE_SIZE) / 1024;
        processedContent += `\n\nThis file is too large, truncated at 30KB. There is ${remainingSize.toFixed(2)}KB remaining.`;
        isTruncated = true;
        displaySize = MAX_DISPLAY_FILE_SIZE;
      }

      originalTotalSize += size;
      displayTotalSize += displaySize;

      fileTree.set(fileRelative, {
        size,
        content: processedContent,
        isTruncated,
      });
    }
  }

  // 単一ファイル指定の場合
  if (targetFile) {
    const fileEntry = fileTree.get(targetFile);
    if (!fileEntry) {
      throw new Error(`File not found: ${targetFile}`);
    }
    return fileEntry.content;
  }

  // レスポンス生成
  if (isTreeMode) {
    let resultText = "# Directory Structure\n\n";
    resultText += createTreeDisplay(fileTree, false);

    const readmeFiles = Array.from(fileTree.entries()).filter(
      ([path, { content }]) => /readme\.md$/i.test(path) && content,
    );

    if (readmeFiles.length > 0) {
      resultText += "\n# README Files\n\n";
      for (const [path, { content }] of readmeFiles) {
        resultText += `## ${path}\n\n${content}\n\n`;
      }
    }

    return resultText;
  } else {
    let resultText = "# 📁 File Tree\n\n";
    resultText += createTreeDisplay(fileTree, true);

    resultText += `\n# 📝 Files (Total: ${(originalTotalSize / 1024).toFixed(2)} KB→${(displayTotalSize / 1024).toFixed(2)} KB)\n\n`;
    for (const [path, { content }] of fileTree) {
      resultText += `\`\`\`${path}\n${content}\n\`\`\`\n\n`;
    }

    return resultText;
  }
}

// ディレクトリツリー文字列の生成
function createTreeDisplay(
  fileTree: Map<string, { size: number; content: string; isTruncated?: boolean }>,
  showSize = false,
): string {
  const dirs = new Set<string>();

  for (const [path] of fileTree) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }

  const sortedDirs = Array.from(dirs).sort();
  let result = "";

  for (const dir of sortedDirs) {
    const depth = dir.split("/").length - 1;
    const indent = "  ".repeat(depth);
    const name = dir.split("/").pop() || "";
    const isFile = !Array.from(dirs).some((d) => d.startsWith(dir + "/"));

    if (showSize && isFile) {
      const fileInfo = fileTree.get(dir);
      if (fileInfo) {
        const sizeKB = (fileInfo.size / 1024).toFixed(2);
        if (fileInfo.isTruncated) {
          result += `${indent}📄 ${name} (${sizeKB} KB→30KB truncated)\n`;
        } else {
          result += `${indent}📄 ${name} (${sizeKB} KB)\n`;
        }
      } else {
        result += `${indent}📄 ${name} (0.00 KB)\n`;
      }
    } else {
      result += `${indent}${isFile ? "📄" : "📂"} ${name}\n`;
    }
  }

  return result;
}

// バイナリコンテンツ判定
function isBinaryContent(content: string): boolean {
  const sampleSize = Math.min(content.length, 1000);
  let nonPrintable = 0;
  for (let i = 0; i < sampleSize; i++) {
    const charCode = content.charCodeAt(i);
    if (charCode === 0 || (charCode < 32 && ![9, 10, 13].includes(charCode))) {
      nonPrintable++;
    }
  }
  return nonPrintable / sampleSize > 0.05;
}

// 出力スキップ判定用（バイナリや大サイズファイル、ロックファイルなど）
function shouldSkipFile(
  filename: string,
  size: number,
  content: string | undefined,
  hasTsConfig: boolean,
): boolean {
  const MAX_FILE_SIZE = 500 * 1024; // 500KB
  const imageExtensions = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".webp",
    ".svg",
  ]);
  const binaryExtensions = new Set([
    ".zip",
    ".tar",
    ".gz",
    ".rar",
    ".7z",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".mp3",
    ".mp4",
    ".avi",
    ".mov",
    ".wav",
    ".bin",
    ".dat",
    ".db",
    ".sqlite",
  ]);

  const ext = filename.toLowerCase().split(".").pop() || "";

  // ロックファイル除外
  if (filename.match(/-lock\.|\.lock$/)) return true;

  // バイナリ拡張子除外
  if (imageExtensions.has(`.${ext}`) || binaryExtensions.has(`.${ext}`)) return true;

  // TSプロジェクトの場合、.jsや.mjsは除外
  if (hasTsConfig && (filename.endsWith(".js") || filename.endsWith(".mjs"))) return true;

  // サイズ制限
  if (size > MAX_FILE_SIZE) return true;

  // 中身がバイナリ
  if (content && isBinaryContent(content)) return true;

  return false;
}

// ディレクトリ・拡張子フィルタによる出力可否
function shouldIncludeFile(filename: string, targetDirs: string[], targetExts: string[]): boolean {
  // ディレクトリフィルタ
  if (targetDirs.length > 0) {
    const matchesDir = targetDirs.some((dir) => {
      const normalizedDir = dir.endsWith("/") ? dir : `${dir}/`;
      return filename.startsWith(normalizedDir);
    });
    if (!matchesDir) return false;
  }

  // 拡張子フィルタ
  if (targetExts.length > 0) {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    if (!targetExts.includes(ext)) return false;
  }

  return true;
}
