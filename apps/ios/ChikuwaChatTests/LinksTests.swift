import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

final class LinksTests: XCTestCase {
    func testFirstLinkOutsideCodeWithTrailingPunctuationTrimmed() {
        XCTAssertEqual(Links.first(in: "see https://example.com/a?b=1, then https://other.test"), "https://example.com/a?b=1")
        XCTAssertEqual(Links.first(in: "日本語の文 https://example.com/x。"), "https://example.com/x")
        XCTAssertEqual(Links.first(in: "(https://example.com/paren)"), "https://example.com/paren")
        XCTAssertNil(Links.first(in: "`https://code.example.com` and ```\nhttps://fenced.example.com\n``` none"))
        XCTAssertNil(Links.first(in: "no links here"))
        XCTAssertEqual(Links.first(in: "[label](https://example.com/md)"), "https://example.com/md")
    }
}

/// A message with a link asks for its preview when its row is shown, and the card comes once it is there. The card used
/// to ask for it itself, from a `.task` on its own view, which is empty until the preview has come: an empty view runs
/// no task, so no request was ever made and no card showed (audit 2026-09-30).
@MainActor
final class LinkPreviewRowTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        StubProtocol.handler = nil
    }

    func testTheRowAsksForItsLinksPreviewAndShowsTheCard() throws {
        let link = "https://www.python.org/"
        var asked: [String] = []
        StubProtocol.handler = { request in
            guard request.url?.path == "/api/v1/link-previews" else { return (404, Data(#"{"detail":"Not Found"}"#.utf8)) }
            let url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "url" }?.value
            DispatchQueue.main.async { asked.append(url ?? "") }
            return (200, Data(#"""
                {"url":"https://www.python.org/","status":"ok","title":"Welcome to Python.org","description":"The official home",
                 "image_url":null,"site_name":"Python.org","fetched_at":"2026-09-30T00:00:00Z"}
                """#.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let api = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        api.accessToken = "a"
        let controller = AppController(defaults: UserDefaults(suiteName: "link-preview-\(UUID().uuidString)")!)
        controller.api = api
        controller.store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                                      email: nil, mustChangePassword: false))
        var message = MessageState(placeholderFor: "k1", channelId: "c1", senderId: "me", body: "Python の公式サイト \(link)",
                                   createdAt: "2026-09-30T10:50:00Z")
        message.id = "m1"
        message.seq = 1
        message.updatedSeq = 1
        message.pending = false

        // In a stack with other rows, as in the conversation (hosted alone, the empty card still ran its task).
        let size = CGSize(width: 393, height: 600)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: VStack(alignment: .leading, spacing: 0) {
            Text("above")
            MessageRow(message: message, controller: controller).equatable()
            Text("below")
            Spacer()
        })
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        let fits = CGSize(width: size.width, height: UIView.layoutFittingCompressedSize.height)
        let before = host.sizeThatFits(in: fits).height

        let deadline = Date().addingTimeInterval(3)
        while controller.linkPreviews[link] == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        host.view.layoutIfNeeded()

        XCTAssertEqual(asked, [link], "the row asks the server for its link's preview, once")
        XCTAssertEqual(controller.linkPreviews[link]??.title, "Welcome to Python.org")
        XCTAssertGreaterThan(host.sizeThatFits(in: fits).height, before + 30, "the card is under the message")
    }
}
