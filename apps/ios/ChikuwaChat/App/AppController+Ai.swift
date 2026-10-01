import Foundation

/// M66 (docs/AI.md): AI bots and private summaries.
extension AppController {
    /// The engine's AI state (views under test pass their own hub).
    var aiHub: AiHub? { engine?.ai }

    /// Is this user one of the server's AI bots (its 「AI」 mark instead of 「BOT」)?
    func isAiBot(_ userId: String) -> Bool { aiHub?.isAiBot(userId) ?? false }

    /// The 「要約」 entries show while the server can summarize, in a conversation I belong to.
    func canSummarize(_ channelId: String) -> Bool {
        aiHub?.summaryAvailable == true && store.channel(channelId)?.isMember == true
    }

    /// A 「要約」 choice: the sheet opens on `request` and shows the run from its first state.
    func summarize(_ request: AiSummaryRequest) {
        guard let hub = aiHub else { return }
        Task { await hub.startSummary(request) }
    }
}
