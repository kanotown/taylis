import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// The lab roster (M23, DATA_MODEL.md lab_profiles): the order shared with the server and the desktop, the labels, the
/// wire shapes and the engine following roster.updated.
@MainActor
final class RosterTests: XCTestCase {
    private func person(_ id: String, _ name: String) -> UserPublic {
        UserPublic(id: id, username: id, displayName: name, role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
    }

    private func line(_ user: UserPublic, _ affiliation: String = "student", rank: String? = nil, grade: String? = nil,
                      supervisorId: String? = nil, topic: String? = nil, reading: String? = nil) -> LabProfileOut {
        LabProfileOut(userId: user.id, affiliation: affiliation, rank: rank, grade: grade, supervisorId: supervisorId,
                      researchTopic: topic, reading: reading, updatedAt: "")
    }

    private func byId(_ lines: [LabProfileOut]) -> [String: LabProfileOut] { Dictionary(uniqueKeysWithValues: lines.map { ($0.userId, $0) }) }

    func testOrdersFacultyByRankStudentsFromD3DownOthersAlumniThenPeopleOffTheRoster() {
        // The same people and order as the server's test_the_roster_orders_people_and_keeps_the_grade_groups and the
        // desktop's roster.test.ts.
        let prof = person("prof", "Prof")
        let assoc = person("assoc", "Assoc")
        let doc = person("doc", "Doc")
        let m1a = person("m1a", "M1a")
        let m1b = person("m1b", "M1b")
        let four = person("four", "Four")
        let old = person("old", "Old")
        let guest = person("guest", "Guest")
        let roster = byId([
            line(prof, "faculty", rank: "professor"),
            line(assoc, "faculty", rank: "associate_professor"),
            line(doc, grade: "D1", supervisorId: prof.id),
            line(m1a, grade: "M1", reading: "いとう"),
            line(m1b, grade: "M1", reading: "あおき"),
            line(four, grade: "B4"),
            line(old, "alumni"),
        ])
        let sorted = [guest, old, four, m1a, m1b, doc, assoc, prof].sorted { Roster.compareByRoster($0, $1, roster) < 0 }
        XCTAssertEqual(sorted.map(\.id), ["prof", "assoc", "doc", "m1b", "m1a", "four", "old", "guest"])

        XCTAssertEqual(Roster.label(roster["assoc"]!), "准教授")
        XCTAssertEqual(Roster.section(roster["assoc"]), "教員")
        XCTAssertEqual(Roster.section(roster["m1a"]), "M1")
        XCTAssertEqual(Roster.section(roster["old"]), "卒業生")
        XCTAssertNil(Roster.section(nil))
        XCTAssertEqual(Roster.summary(roster["doc"]!, users: [prof.id: prof]), "D1 · 指導教員：Prof")
        XCTAssertEqual(Roster.summary(roster["doc"]!, users: [:]), "D1") // the supervisor is not someone this user can see

        // The directory's headings, then everyone else under その他のメンバー.
        let parts = Roster.sections(sorted, roster)
        XCTAssertEqual(parts.map(\.title), ["教員", "D1", "M1", "B4", "卒業生", "その他のメンバー"])
        XCTAssertEqual(parts.map { $0.people.map(\.id) }, [["prof", "assoc"], ["doc"], ["m1b", "m1a"], ["four"], ["old"], ["guest"]])
    }

    func testLabelsForEveryStepAndValuesThisVersionDoesNotKnow() {
        let a = person("a", "A")
        XCTAssertEqual(Roster.label(line(a, "faculty")), "教員")  // faculty without a rank
        XCTAssertEqual(Roster.label(line(a, "faculty", rank: "lecturer")), "講師")
        XCTAssertEqual(Roster.label(line(a, "faculty", rank: "assistant_professor")), "助教")
        XCTAssertEqual(Roster.label(line(a, "faculty", rank: "professor")), "教授")
        XCTAssertEqual(Roster.label(line(a)), "学生")
        XCTAssertEqual(Roster.section(line(a)), "学生")
        XCTAssertEqual(Roster.label(line(a, grade: "B3")), "B3")
        XCTAssertEqual(Roster.label(line(a, "other")), "その他")
        XCTAssertEqual(Roster.section(line(a, "other")), "その他")
        // A newer server's affiliation: no label, and it sorts after the known steps but before people off the roster.
        let visitor = person("v", "V")
        let off = person("o", "O")
        let roster = byId([line(visitor, "visiting"), line(a, "alumni")])
        XCTAssertNil(Roster.label(roster["v"]!))
        XCTAssertNil(Roster.section(roster["v"]))
        XCTAssertEqual([off, visitor, a].sorted { Roster.compareByRoster($0, $1, roster) < 0 }.map(\.id), ["a", "v", "o"])
        XCTAssertEqual(Roster.sections([a, visitor, off], roster).map(\.title), ["卒業生", "その他のメンバー"])
    }

    func testNamesCompareByCodePointAsOnTheServer() {
        // Uppercase before lowercase, kana before kanji, and no locale collation.
        XCTAssertEqual(Roster.codePointOrder("Zeta", "alpha"), -1)
        XCTAssertEqual(Roster.codePointOrder("かのう", "加納"), -1)
        XCTAssertEqual(Roster.codePointOrder("あおき", "あおき"), 0)
        XCTAssertEqual(Roster.codePointOrder("あお", "あおき"), -1)
        // A decomposed が (か + U+3099) is canonically equal to the precomposed one for Swift's `==` / `<`, but Python
        // compares code points: U+304B sorts before U+304C.
        XCTAssertEqual(Roster.codePointOrder("か\u{3099}", "が"), -1)
        XCTAssertFalse("か\u{3099}" < "が")

        // Same reading: the username decides; no reading: the display name stands in.
        let x = person("x", "Same")
        let y = person("y", "Same")
        let z = person("z", "あい")
        let roster = byId([line(y, grade: "M2", reading: "あい"), line(x, grade: "M2", reading: "あい"), line(z, grade: "M2")])
        XCTAssertEqual([z, y, x].sorted { Roster.compareByRoster($0, $1, roster) < 0 }.map(\.id), ["x", "y", "z"])
    }

    func testListsKeepTheirOwnOrderUntilSomeoneIsOnTheRoster() {
        let kano = person("kano", "Kano")
        let bob = person("bob", "Bob")
        let ann = person("ann", "Ann")
        let byName: (UserPublic, UserPublic) -> Bool = { $0.displayName < $1.displayName }
        XCTAssertEqual(Roster.sorted([kano, bob, ann], [:], otherwise: byName).map(\.id), ["ann", "bob", "kano"])
        let roster = byId([line(kano, grade: "M1")])
        XCTAssertEqual(Roster.sorted([bob, ann, kano], roster, otherwise: byName).map(\.id), ["kano", "ann", "bob"])
    }

    // MARK: wire shapes

    private func bootstrapJson(_ extra: String) -> Data {
        Data("""
        {"server_time": "2026-09-28T00:00:00Z",
         "me": {"id": "u1", "username": "kano", "display_name": "加納", "role": "member", "deactivated_at": null, "created_at": "",
                "updated_at": "", "email": null, "must_change_password": false},
         "users": [], "channels": [],
         "limits": {"max_message_length": 20000, "max_attachment_bytes": 1, "max_attachments_per_message": 10}\(extra)}
        """.utf8)
    }

    func testBootstrapAndGroupsDecodeWithAndWithoutTheRosterFields() throws {
        // An older server: no roster, groups without `managed`. The synthesized decoder would have refused the group.
        let older = try JSON.snakeDecoder.decode(BootstrapOut.self, from: bootstrapJson("""
        , "groups": [{"id": "g1", "name": "design", "description": null, "member_ids": ["u1"], "created_by": "u1", "created_at": "", "updated_at": ""}]
        """))
        XCTAssertNil(older.roster)
        XCTAssertEqual(older.groups?.first?.managed, false)
        XCTAssertEqual(older.groups?.first?.memberIds, ["u1"])

        let current = try JSON.snakeDecoder.decode(BootstrapOut.self, from: bootstrapJson("""
        , "groups": [{"id": "g2", "name": "m1", "description": "M1 (名簿から自動)", "member_ids": ["u1"], "created_by": "u2",
                      "created_at": "", "updated_at": "", "managed": true}],
          "roster": [{"user_id": "u1", "affiliation": "student", "rank": null, "grade": "M1", "supervisor_id": "u2",
                      "research_topic": "拡散モデルによる音声合成", "reading": "かのう", "updated_at": "2026-09-28T00:00:00Z"},
                     {"user_id": "u3", "affiliation": "visiting", "rank": null, "grade": null, "supervisor_id": null,
                      "research_topic": null, "reading": null, "updated_at": "2026-09-28T00:00:00Z"}]
        """))
        XCTAssertEqual(current.groups?.first?.managed, true)
        XCTAssertEqual(current.roster?.count, 2)
        XCTAssertEqual(current.roster?.first, LabProfileOut(userId: "u1", affiliation: "student", grade: "M1", supervisorId: "u2",
                                                            researchTopic: "拡散モデルによる音声合成", reading: "かのう", updatedAt: "2026-09-28T00:00:00Z"))
        XCTAssertEqual(current.roster?.last?.affiliation, "visiting") // an affiliation this version does not know still decodes

        // A group written back (tests, events) keeps the flag.
        let group = try XCTUnwrap(current.groups?.first)
        XCTAssertEqual(try JSON.snakeDecoder.decode(GroupOut.self, from: JSON.snakeEncoder.encode(group)), group)
    }

    func testMyLineIsSavedWithPatchAndBothFieldsSent() async throws {
        var requests: [(String, [String: Any])] = []
        StubProtocol.handler = { request in
            let body = request.httpBodyStream.map { stream -> Data in
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                return data
            } ?? Data()
            requests.append(("\(request.httpMethod ?? "GET") \(request.url!.path)", (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]))
            return (200, Data(#"{"user_id": "u1", "affiliation": "student", "rank": null, "grade": "M1", "supervisor_id": null, "research_topic": "音声合成", "reading": null, "updated_at": "2026-09-28T00:00:00Z"}"#.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "a"
        let saved = try await client.updateMyRosterLine(researchTopic: "音声合成", reading: nil)
        XCTAssertEqual(saved.researchTopic, "音声合成")
        XCTAssertEqual(requests.map(\.0), ["PATCH /api/v1/lab/roster/me"])
        XCTAssertEqual(requests.first?.1["research_topic"] as? String, "音声合成")
        XCTAssertTrue(requests.first?.1["reading"] is NSNull) // null clears; an omitted field would keep the old reading
    }

    // MARK: sync

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    func testTheRosterLoadsFromBootstrapAndFollowsRosterUpdated() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        _ = server.createChannel("general", ownerId: alice.id)
        server.roster[bob.id] = line(bob, grade: "M1")
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: alice.id), connect: server.connector(for: alice.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        await engine.start()
        await settle(engine)
        XCTAssertEqual(store.roster[bob.id]?.grade, "M1")

        server.setRosterLine(bob.id, line(bob, grade: "M2", topic: "音声合成"))
        await settle(engine)
        XCTAssertEqual(store.roster[bob.id]?.grade, "M2")
        XCTAssertEqual(store.roster[bob.id]?.researchTopic, "音声合成")

        server.setRosterLine(alice.id, line(alice, "faculty", rank: "professor"))
        server.setRosterLine(bob.id, nil) // taken off the roster
        await settle(engine)
        XCTAssertNil(store.roster[bob.id])
        XCTAssertEqual(store.roster[alice.id]?.rank, "professor")

        // A reconnect's bootstrap replaces the whole table (a line removed while the socket was down is gone).
        server.roster[alice.id] = nil
        server.disconnect(alice.id)
        for _ in 0..<50 where engine.status != .online || store.roster[alice.id] != nil { await settle(engine) }
        XCTAssertTrue(store.roster.isEmpty)
        engine.stop()
    }
}

/// Renders the member directory, a channel's members, the profile card and the settings with a lab roster (M23);
/// writes PNGs when SNAPSHOT_DIR is set (`TEST_RUNNER_SNAPSHOT_DIR=/path xcodebuild test …`).
@MainActor
final class RosterSnapshotTests: XCTestCase {
    private func render<V: View>(_ view: V, size: CGSize, name: String) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: view)
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) { window.layer.render(in: context.cgContext) }
        }
        window.isHidden = true
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            print("snapshot written: \(url.path)")
        }
        return image
    }

    func testDirectoryProfileAndSettingsRenderWithTheRoster() throws {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "tanaka", displayName: "田中 一郎", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        let people: [(String, String, String, String?)] = [
            ("me", "tanaka", "田中 一郎", nil), ("prof", "kano", "加納 徹", "教授"), ("assoc", "sato", "佐藤 花子", nil), ("doc", "suzuki", "鈴木 次郎", nil),
            ("m1", "ito", "伊藤 三郎", nil), ("b4", "yamada", "山田 四郎", nil), ("old", "watanabe", "渡辺 五郎", nil), ("guest", "guest", "Guest", nil),
        ]
        for (id, username, name, title) in people {
            store.upsertUser(UserPublic(id: id, username: username, displayName: name, role: id == "prof" ? "admin" : "member", deactivatedAt: nil,
                                        createdAt: "", updatedAt: "", title: title))
        }
        store.replaceRoster([
            LabProfileOut(userId: "prof", affiliation: "faculty", rank: "professor", reading: "かのう とおる", updatedAt: ""),
            LabProfileOut(userId: "assoc", affiliation: "faculty", rank: "associate_professor", reading: "さとう はなこ", updatedAt: ""),
            LabProfileOut(userId: "doc", affiliation: "student", grade: "D1", supervisorId: "prof", researchTopic: "拡散モデルによる音声合成", updatedAt: ""),
            LabProfileOut(userId: "me", affiliation: "student", grade: "M1", supervisorId: "prof", researchTopic: "日本語の音声認識", reading: "たなか", updatedAt: ""),
            LabProfileOut(userId: "m1", affiliation: "student", grade: "M1", reading: "いとう", updatedAt: ""),
            LabProfileOut(userId: "b4", affiliation: "student", grade: "B4", updatedAt: ""),
            LabProfileOut(userId: "old", affiliation: "alumni", updatedAt: ""),
        ])

        let directory = try render(DirectoryView(controller: controller, onOpen: { _ in }), size: CGSize(width: 393, height: 852), name: "roster-directory.png")
        XCTAssertGreaterThan(directory.size.width, 0)
        let profile = try render(ProfileSheet(controller: controller, userId: "me"), size: CGSize(width: 393, height: 600), name: "roster-profile.png")
        XCTAssertGreaterThan(profile.size.width, 0)
        // M40: my roster fields are on 自分 → プロフィールを編集.
        let settings = try render(NavigationStack { ProfileEditView(controller: controller) }, size: CGSize(width: 393, height: 852), name: "roster-settings.png")
        XCTAssertGreaterThan(settings.size.width, 0)
        let you = try render(YouView(controller: controller, path: .constant([])), size: CGSize(width: 393, height: 852), name: "roster-you.png")
        XCTAssertGreaterThan(you.size.width, 0)
    }
}
