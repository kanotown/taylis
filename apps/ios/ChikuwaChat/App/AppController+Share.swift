import Foundation

/// The app's side of the Share Extension (MOBILE_UI.md §21): what it leaves in the App Group for the share sheet, and
/// the shares it finishes.
extension AppController {
    /// At start, before anything reads the Keychain: an older build's items move into the shared group (nobody is
    /// signed out), the share sheet gets the workspace list, and shares left pending are sent.
    func startSharing() {
        Keychain.migrateToSharedGroup()
        SharedContainer.saveWorkspaces(workspaces, active: activeServerUrl)
        Task { await resumeShares() }
        // CF5 (docs/CHANNEL_FILES.md §12.4): a composer's upload that is done puts its link into the draft.
        DriveUploadCenter.shared.onBatches = { [weak self] batches in self?.linkComposerUploads(batches) }
        Task { await DriveUploadCenter.shared.resume() } // docs/DRIVE.md §29: drive uploads a restart left
    }

    /// Shares the extension left (offline, closed before the uploads ended, a session to refresh) are sent now; a
    /// share past its 7 days is given up with a notice.
    func resumeShares() async {
        guard let processor = ShareProcessor.shared, let pending = PendingShareStore.shared else { return }
        for expired in pending.sweep() {
            notice = tr("「\(expired.channelTitle)」への共有を送信できませんでした（7日を過ぎました）")
        }
        await processor.setOutcomeHandler { [weak self] share, outcome in
            Task { @MainActor in self?.shareConcluded(share, outcome) }
        }
        await processor.resumeAll()
    }

    /// A share the app finished: a refusal is said (a posted one shows in its conversation by the usual sync).
    func shareConcluded(_ share: PendingShare, _ outcome: ShareOutcome) {
        guard case .failed(let failure) = outcome else { return }
        let reason: String
        switch failure {
        case .refused(_, let code): reason = ErrorMessages.byCode[code] ?? ErrorMessages.unknown
        case .notSignedIn: reason = ErrorMessages.byCode["invalid_token"] ?? ErrorMessages.unknown
        case .temporary: reason = ErrorMessages.network
        }
        notice = tr("「\(share.channelTitle)」への共有を送信できませんでした：\(reason)")
    }

    /// What the share sheet shows without asking the server: the open workspace's conversations I can post in (newest
    /// message first), its attachment limits and the UI language. Written when the app goes to the background.
    func publishShareCache() {
        SharedContainer.saveLanguage(UILanguage.shared.effective.rawValue)
        guard let workspace = activeWorkspace, let me = store.me else { return }
        let isAdmin = me.role == "admin"
        let list = store.channels.values.compactMap { state -> ShareDestination? in
            let channel = state.channel
            guard state.isMember, !channel.archived else { return nil }
            if channel.isAnnouncement, !isAdmin, channel.membership?.role != "owner" { return nil }
            let keywords = channel.isDm ? (channel.dmUserIds ?? []).compactMap { store.users[$0]?.username }.joined(separator: " ") : ""
            return ShareDestination(id: channel.id, title: channelTitle(state, store: store), kind: channel.type,
                                    lastMessageAt: channel.lastMessageAt ?? channel.createdAt, keywords: keywords)
        }
        ShareDestinations.saveRecent(ShareDestinations.ordered(list), account: workspace.account)
        if let limits = store.limits {
            SharedContainer.saveLimits(ShareLimits(maxAttachmentBytes: Int64(limits.maxAttachmentBytes),
                                                   maxAttachmentsPerMessage: limits.maxAttachmentsPerMessage), account: workspace.account)
        }
    }

    // MARK: CF5 — files over the attachment limit from the composer (docs/CHANNEL_FILES.md §12.4)

    /// Where a file over the attachment limit added to this conversation's composer may go; nil: the size error.
    func composerDrivePlan(_ channelId: String) -> ComposerDrive.Plan? {
        guard let channel = store.channel(channelId)?.channel else { return nil }
        return ComposerDrive.plan(channel, settings: store.workspaceSettings, driveAvailable: drive?.available == true)
    }

    /// The plan's folder, asked of the server (the channel's drive is made on first use); nil after saying why not.
    func composerDriveTarget(_ channelId: String, plan: ComposerDrive.Plan) async -> ComposerDrive.Resolved? {
        guard let api, let channel = store.channel(channelId)?.channel else { return nil }
        do { return try await ComposerDrive.resolve(plan, channel: channel, api: api, zone: store.channelFilesZone ?? DriveUploadRules.postsZone) } catch {
            self.error = describe(error)
            return nil
        }
    }

    /// The files go up as one background batch tied to the composer; a name taken in the folder keeps both (as the
    /// server does for posted files), so nothing is asked.
    func uploadFromComposer(_ sources: [DriveUploadSource], to target: DriveUploadTarget, channelId: String, parentId: String?) async {
        guard let workspace = activeWorkspace else { return }
        let composer = DriveUploadComposer(channelId: channelId, parentId: parentId)
        if let problem = await DriveUploadCenter.shared.add(sources, to: target, workspace: workspace, onConflict: "rename", composer: composer) {
            error = problem
        }
    }

    /// The active account's composer uploads that are done: each link goes at the end of its conversation's draft
    /// (once; the draft then syncs to my other devices as typed text does). A file I can no longer read (§28.3) has no
    /// link to give.
    func linkComposerUploads(_ batches: [DriveUploadBatch]) {
        let center = DriveUploadCenter.shared
        let rows = ComposerDrive.finished(batches, account: activeWorkspace?.account).filter { center.takeLink($0) }
        guard !rows.isEmpty else { return }
        let unlinked = ComposerDrive.link(rows, store: store)
        for row in rows { center.markLinked(row) }
        if let name = unlinked.first { error = tr("「\(name)」はアップロードしましたが、リンクを作れませんでした") }
    }
}
