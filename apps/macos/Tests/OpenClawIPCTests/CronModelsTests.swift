import Foundation
import Testing
@testable import OpenClaw

@Suite(.disabled("Cron model tests hang the Swift Testing runner on release macOS workers."))
struct CronModelsTests {
    @Test func `schedule at encodes and decodes`() throws {
        let schedule = CronSchedule.at(at: "2026-02-03T18:00:00Z")
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func `schedule at decodes legacy at ms`() throws {
        let json = """
        {"kind":"at","atMs":1700000000000}
        """
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: Data(json.utf8))
        if case let .at(at) = decoded {
            #expect(at.hasPrefix("2023-"))
        } else {
            #expect(Bool(false))
        }
    }

    @Test func `schedule every encodes and decodes with anchor`() throws {
        let schedule = CronSchedule.every(everyMs: 5000, anchorMs: 10000)
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func `schedule cron encodes and decodes with timezone`() throws {
        let schedule = CronSchedule.cron(expr: "*/5 * * * *", tz: "Europe/Vienna")
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func `payload agent turn encodes and decodes`() throws {
        let payload = CronPayload.agentTurn(
            message: "hello",
            thinking: "low",
            timeoutSeconds: 15,
            deliver: true,
            channel: "whatsapp",
            to: "+15551234567",
            bestEffortDeliver: false)
        let data = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(CronPayload.self, from: data)
        #expect(decoded == payload)
    }

    @Test func `job encodes and decodes delete after run`() throws {
        let job = CronJob(
            id: "job-1",
            agentId: nil,
            name: "One-shot",
            description: nil,
            enabled: true,
            deleteAfterRun: true,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: .at(at: "2026-02-03T18:00:00Z"),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: "ping"),
            delivery: nil,
            state: CronJobState())
        let data = try JSONEncoder().encode(job)
        let decoded = try JSONDecoder().decode(CronJob.self, from: data)
        #expect(decoded.deleteAfterRun == true)
    }
}
