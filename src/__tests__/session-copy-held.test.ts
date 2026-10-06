/**
 * What a session holds of a history.
 *
 * A resume sends the turns after what the session holds as a delta, and the
 * delta keeps only the user's side of them: the assistant's, for turns the
 * session wrote itself, are already in it. A reply the session did not write
 * is lost to the model.
 */
import { describe, it, expect } from "bun:test"
import { messagesHeld } from "../proxy/session/cache"
import type { LineageResult, SessionState } from "../proxy/session/lineage"

const session: SessionState = { claudeSessionId: "s", lastAccess: 0, messageCount: 1, lineageHash: "h" }
const user = (text: string) => ({ role: "user", content: text })
const assistant = (text: string) => ({ role: "assistant", content: text })
const continuation = (resumeFrom: number): LineageResult => ({ type: "continuation", session, resumeFrom })

describe("messagesHeld", () => {
  it("counts what a continuation resumes from and the reply it wrote to it", () => {
    expect(messagesHeld(continuation(1), [user("q1"), assistant("a1"), user("q2")])).toBe(2)
  })

  it("counts nothing of a diverged session", () => {
    expect(messagesHeld({ type: "diverged", reason: "unrelated-history" }, [user("q1")])).toBe(0)
  })
})
