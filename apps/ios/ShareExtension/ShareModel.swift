import Foundation
import Observation
import UIKit

/// The share sheet's state (MOBILE_UI.md §20): the workspace, what is shared, the message, the destination, and the
/// sending.
@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable {
        case loading
        /// No workspace with a session this extension can read: open Taylis and sign in.
        case notSignedIn
        case editing
        case sending
        case sent
        /// Kept in the App Group; Taylis sends it when it next opens.
        case pending(String)
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var workspaces: [Workspace] = []
    private(set) var workspace: Workspace?
    private(set) var destinations: ShareDestinationModel?
    var destination: ShareDestination?
    var text = ""
    private(set) var files: [StagedFile] = []
    private(set) var thumbnails: [String: UIImage] = [:]
    private(set) var unreadable = 0
    private(set) var progress: Double = 0

    @ObservationIgnored private let providers: [NSItemProvider]
    @ObservationIgnored private let finish: (Bool) -> Void
    @ObservationIgnored private let shareId = UUID().uuidString.lowercased()
    /// Held while the sheet is open, so the app's sweep leaves the folder alone.
    @ObservationIgnored private var stagingLock: FileLock?

    init(providers: [NSItemProvider], finish: @escaping (Bool) -> Void) {
        self.providers = providers
        self.finish = finish
    }

    private var store: PendingShareStore? { PendingShareStore.shared }

    var limits: ShareLimits {
        workspace.flatMap { SharedContainer.limits(account: $0.account) } ?? .fallback
    }

    /// The files over the server's size limit.
    var tooLarge: [StagedFile] { files.filter { $0.size > limits.maxAttachmentBytes } }
    var tooMany: Bool { files.count > limits.maxAttachmentsPerMessage }
    var isEmpty: Bool { files.isEmpty && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var canSend: Bool { phase == .editing && destination != nil && !isEmpty && tooLarge.isEmpty && !tooMany }

    func start() async {
        workspaces = SharedContainer.workspaces().filter { $0.isSignedIn && SharedTokens.refreshToken(account: $0.account) != nil }
        guard let store, let first = workspaces.first else {
            phase = .notSignedIn
            return
        }
        // Claimed before anything is copied in: the app sweeps a folder nobody holds that has no share.json.
        stagingLock = store.claim(shareId)
        guard (try? store.makeFolder(shareId)) != nil else {
            phase = .failed(localized("共有を保存できませんでした。空き容量を確かめてください"))
            return
        }
        select(first)
        let input = await ShareItems.load(providers, into: store.filesFolder(shareId))
        files = input.files
        unreadable = input.unreadable
        text = input.texts.joined(separator: "\n")
        phase = .editing
        let scale = UIScreen.main.scale
        for file in files where file.isImage || file.isVideo || file.contentType == "application/pdf" {
            if let image = await ShareItems.thumbnail(file.url, side: 88, scale: scale) { thumbnails[file.id] = image }
        }
    }

    func select(_ workspace: Workspace) {
        guard workspace.serverUrl != self.workspace?.serverUrl, let api = ShareApi(workspace: workspace) else { return }
        self.workspace = workspace
        destination = nil
        let model = ShareDestinationModel(workspace: workspace, api: api)
        destinations = model
        if model.recent.isEmpty { Task { await model.loadAll() } }
    }

    func remove(_ file: StagedFile) {
        files.removeAll { $0.id == file.id }
        try? FileManager.default.removeItem(at: file.url)
    }

    func cancel() {
        stagingLock?.release()
        store?.remove(shareId)
        finish(false)
    }

    /// 送信: the share is saved in the App Group first (so nothing is lost if this sheet ends), then sent: uploads
    /// through a background session, then the message.
    func send() async {
        guard canSend, let store, let workspace, let destination, let processor = ShareProcessor.shared else { return }
        phase = .sending
        let share = PendingShare(
            id: shareId, clientMsgId: UUID().uuidString.lowercased(), serverUrl: workspace.serverUrl, account: workspace.account,
            channelId: destination.id, channelTitle: destination.title, parentId: nil,
            text: text.trimmingCharacters(in: .whitespacesAndNewlines), createdAt: Date(),
            items: files.map { PendingShare.Item(file: $0.file, filename: $0.filename, contentType: $0.contentType, size: $0.size,
                                                 boundary: "chikuwa-" + UUID().uuidString) })
        do {
            try store.save(share)
        } catch {
            phase = .failed(localized("共有を保存できませんでした。空き容量を確かめてください"))
            return
        }
        stagingLock?.release()
        stagingLock = nil
        let watcher = Task { [weak self] in
            while !Task.isCancelled {
                let value = await processor.progress(share.id)
                self?.progress = value
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
        }
        let outcome = await processor.send(share.id)
        watcher.cancel()
        switch outcome {
        case .posted:
            progress = 1
            phase = .sent
            try? await Task.sleep(nanoseconds: 700_000_000)
            finish(true)
        case .pending(let failure):
            phase = .pending(Self.pendingText(failure))
        case .failed(let failure):
            phase = .failed(Self.failureText(failure))
        case .busy:
            phase = .pending(localized("Taylis が送信しています"))
        }
    }

    /// 閉じる while the files are still going up: the uploads go on in the background and Taylis posts the message.
    func closeWhileSending() {
        Task {
            await ShareProcessor.shared?.detach(shareId)
            finish(true)
        }
    }

    /// 閉じる after the outcome is shown (a pending share stays for the app).
    func close() {
        stagingLock?.release()
        if phase == .notSignedIn { store?.remove(shareId) }
        finish(true)
    }

    static func pendingText(_ failure: ShareFailure) -> String {
        switch failure {
        case .notSignedIn:
            return localized("サインインし直す必要があります。Taylis を開いてサインインすると送信します")
        case .temporary, .refused:
            return localized("今は送信できませんでした。Taylis を開いたときにもう一度送信します")
        }
    }

    static func failureText(_ failure: ShareFailure) -> String {
        switch failure {
        case .notSignedIn:
            return localized("Taylis を開いてサインインしてください")
        case .temporary:
            return ErrorMessages.network
        case .refused(_, let code):
            switch code {
            case "share_file_missing": return localized("ファイルを読み込めませんでした")
            default: return ErrorMessages.byCode[code] ?? ErrorMessages.unknown
            }
        }
    }

    static func formatSize(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
    }
}
