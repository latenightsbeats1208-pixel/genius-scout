import { execFile } from "child_process";

/**
 * Async, non-blocking curl wrapper.
 *
 * Instagram blocks Node's native fetch (TLS fingerprint / bot detection) but
 * not the system `curl`. We previously used execSync, which BLOCKS the entire
 * Node event loop for the duration of the request — fatal for running several
 * scans concurrently (SSE would freeze, all scans would serialize). execFile
 * runs the child process asynchronously so the event loop stays free.
 *
 * Using execFile (not exec) with an args array also avoids shell injection:
 * the URL is passed as a literal argument, never interpolated into a shell
 * command string.
 */
export function curlText(
  url: string,
  opts: { timeoutMs?: number; userAgent?: string } = {}
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const userAgent = opts.userAgent ?? "Mozilla/5.0";

  return new Promise((resolve) => {
    execFile(
      "curl",
      [
        "-s",
        "-L", // follow redirects
        "--max-time",
        String(Math.ceil(timeoutMs / 1000)),
        "-H",
        `User-Agent: ${userAgent}`,
        url,
      ],
      { timeout: timeoutMs + 2000, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(stdout || "");
      }
    );
  });
}

/**
 * Fetch an Instagram profile's embedded JSON via curl and parse the useful
 * fields. Returns null if the profile does not exist or could not be read.
 */
export interface IgRawProfile {
  username: string;
  fullName: string;
  bio: string;
  followers: number | null;
  isPrivate: boolean;
  isVerified: boolean;
  posts: string[];
  externalUrl: string | null;
  category: string | null;
}

export async function curlInstagramProfile(
  handle: string
): Promise<IgRawProfile | null> {
  const safe = handle.replace(/[^a-zA-Z0-9._]/g, "");
  if (!safe) return null;

  const html = await curlText(`https://www.instagram.com/${safe}/`);
  if (!html) return null;
  if (html.includes("Page Not Found") || html.includes("page isn't available")) {
    return null;
  }

  const usernameMatch = html.match(/"username":"([^"]+)"/);
  if (!usernameMatch) return null;

  const bioMatch = html.match(/"biography":"((?:[^"\\]|\\.)*)"/);
  const bio = bioMatch ? unescapeJson(bioMatch[1]) : "";

  const nameMatch = html.match(/"full_name":"((?:[^"\\]|\\.)*)"/);
  const fullName = nameMatch ? unescapeJson(nameMatch[1]) : "";

  const followersMatch = html.match(/"edge_followed_by":\{"count":(\d+)\}/);
  const followers = followersMatch ? Number(followersMatch[1]) : null;

  const privateMatch = html.match(/"is_private":(true|false)/);
  const isPrivate = privateMatch ? privateMatch[1] === "true" : false;

  const verifiedMatch = html.match(/"is_verified":(true|false)/);
  const isVerified = verifiedMatch ? verifiedMatch[1] === "true" : false;

  const extUrlMatch = html.match(/"external_url":"((?:[^"\\]|\\.)*)"/);
  const externalUrl =
    extUrlMatch && extUrlMatch[1] ? unescapeJson(extUrlMatch[1]) : null;

  const catMatch = html.match(/"category_name":"((?:[^"\\]|\\.)*)"/);
  const category = catMatch && catMatch[1] ? unescapeJson(catMatch[1]) : null;

  const posts: string[] = [];
  const captionMatches = html.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g);
  for (const m of captionMatches) {
    const text = unescapeJson(m[1]);
    if (text.length > 10 && text.length < 400) {
      posts.push(text);
      if (posts.length >= 8) break;
    }
  }

  return {
    username: usernameMatch[1],
    fullName,
    bio,
    followers,
    isPrivate,
    isVerified,
    posts,
    externalUrl,
    category,
  };
}

function unescapeJson(s: string): string {
  return s
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\u[\dA-Fa-f]{4}/g, (m) =>
      String.fromCharCode(parseInt(m.slice(2), 16))
    )
    .trim();
}
