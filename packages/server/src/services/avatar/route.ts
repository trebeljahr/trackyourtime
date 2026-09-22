// `GET /api/avatars/:userId/:key` — the one unauthenticated read of user data.
//
// An `<img>` sends no bearer token and, from the shells' origins, no cookie
// either, so the picture has to be fetchable with the URL alone. What keeps it
// private enough is the URL: `key` is 128 random bits, so nobody enumerates
// pictures by user id, and the address changes with every upload.
import type { Express, Request, Response } from "express";
import { AVATAR_PATH_PREFIX } from "@starter/shared";
import { parseAvatarPath } from "./image.js";
import { findAvatar, type StoredAvatar } from "./store.js";

export type AvatarLookup = (userId: string, key: string) => Promise<StoredAvatar | null>;

/** The handler, with the lookup injected so a test drives it without a database. */
export function avatarHandler(lookup: AvatarLookup) {
  return async (req: Request, res: Response): Promise<void> => {
    const path = parseAvatarPath(req.params.userId, req.params.key);
    const stored = path ? await lookup(path.userId, path.key) : null;
    if (!stored) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    // The address is unique per upload, so the bytes behind it never change:
    // cache them for as long as a browser will.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", `"${path!.key}"`);
    // helmet sets `same-origin`, which would stop the web app (another origin)
    // from loading the picture into an <img> at all.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Belt and braces for a decoder bug: the response is an image, never a
    // document, whatever the bytes turn out to be.
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Type", stored.contentType);
    res.setHeader("Content-Length", String(stored.size));
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(stored.bytes);
  };
}

export function registerAvatarRoutes(app: Express, lookup: AvatarLookup = findAvatar): void {
  app.get(`${AVATAR_PATH_PREFIX}/:userId/:key`, (req, res, next) => {
    avatarHandler(lookup)(req, res).catch(next);
  });
}
