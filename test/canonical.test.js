import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/api/app.js";

const app = createApp({ store: {}, verifyToken: async () => null, canonicalHost: "cfbxchange.com" });

test("page visits to www or the onrender.com address move to the main domain", async () => {
  for (const host of ["www.cfbxchange.com", "cfbx.onrender.com"]) {
    const res = await request(app).get("/privacy?x=1").set("Host", host).expect(301);
    assert.equal(res.headers.location, "https://cfbxchange.com/privacy?x=1");
  }
});

test("the main domain, other hosts, health checks and non-GET requests are served in place", async () => {
  await request(app).get("/health").set("Host", "cfbxchange.com").expect(200);
  await request(app).get("/health").set("Host", "cfbx.onrender.com").expect(200);
  await request(app).get("/health").set("Host", "localhost:3000").expect(200);
  const post = await request(app).post("/trade").set("Host", "cfbx.onrender.com").send({});
  assert.notEqual(post.status, 301);
});
