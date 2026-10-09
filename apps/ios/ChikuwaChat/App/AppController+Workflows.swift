import Foundation

/// A workflow's form to show: the workflow, and the conversation it was opened from (posting elsewhere says where it went).
struct WorkflowRunTarget: Identifiable, Equatable {
    let workflow: WorkflowOut
    var here: String? = nil
    /// When posting without asking failed: the key it used (投稿 in the form retries with it, never posting twice) and why.
    var clientMsgId: String? = nil
    var problem: String? = nil
    /// A new form each time (its idempotency key goes with it).
    let id = UUID()
}

/// M95 (docs/WORKFLOWS.md §8): running workflows from the phone.
extension AppController {
    static let workflowListLifetime: TimeInterval = 60

    /// The workflows a channel offers, read again after a minute (`fresh`: now); nil when they cannot be read (an older
    /// server too).
    func channelWorkflows(_ channelId: String, fresh: Bool = false, now: Date = Date()) async -> [WorkflowOut]? {
        if !fresh, let hit = workflowLists[channelId], now.timeIntervalSince(hit.at) < Self.workflowListLifetime { return hit.list }
        guard let api else { return nil }
        do {
            let list = try await api.channelWorkflows(channelId: channelId)
            workflowLists[channelId] = (Date(), list)
            return list
        } catch {
            return nil
        }
    }

    /// The cached list, without reading (the `/` candidates while the list is being read).
    func cachedWorkflows(_ channelId: String) -> [WorkflowOut] { workflowLists[channelId]?.list ?? [] }

    /// 「#name」 of a workflow's target channel.
    func workflowTarget(_ channelId: String) -> String {
        store.channel(channelId)?.channel.name.map { "#\($0)" } ?? tr("送り先のチャンネル")
    }

    /// Opens the form of a workflow I can use; otherwise says why (the label on a message, `/name`). One that does not ask
    /// first (`confirm` off, no fields: WORKFLOWS.md §11) posts at once instead.
    func runWorkflow(_ workflow: WorkflowOut, here: String?) {
        if workflow.postsWithoutAsking {
            Task { await postWithoutAsking(workflow, here: here) }
        } else if workflow.canRun && workflow.runBlocked == nil {
            workflowRun = WorkflowRunTarget(workflow: workflow, here: here)
        } else {
            error = Workflows.runBlockedText(workflow, target: workflowTarget(workflow.channelId)) ?? tr("このワークフローは使えません")
        }
    }

    /// The 「⚡ name」 label: the workflow as it is now (it may have changed, stopped or gone since the message).
    func openWorkflow(id: String) async {
        guard let api else { return }
        do {
            runWorkflow(try await api.workflow(id: id), here: nil)
        } catch {
            self.error = describe(error)
        }
    }

    /// The workflows being posted without asking: a second tap meanwhile does not post again.
    private static var postingWorkflows: Set<String> = []

    /// Posts a workflow that does not ask first. When that fails, its form opens with the reason and the same key, so 投稿
    /// there retries without posting twice.
    func postWithoutAsking(_ workflow: WorkflowOut, here: String?, api: WorkflowApi? = nil) async {
        guard let client = api ?? self.api, !Self.postingWorkflows.contains(workflow.id) else { return }
        Self.postingWorkflows.insert(workflow.id)
        defer { Self.postingWorkflows.remove(workflow.id) }
        let submitter = WorkflowSubmitter(api: client)
        switch await submitter.submit(workflow, values: [:]) {
        case .posted(let message):
            workflowPosted(message, here: here)
        case .invalid:
            workflowRun = WorkflowRunTarget(workflow: workflow, here: here, clientMsgId: submitter.clientMsgId,
                                            problem: tr("入力を確認してください"))
        case .failed(let text):
            workflowRun = WorkflowRunTarget(workflow: workflow, here: here, clientMsgId: submitter.clientMsgId, problem: text)
        }
    }

    /// After a post: the message into the store; elsewhere than `here`, a notice where it went.
    func workflowPosted(_ message: MessageOut, here: String?) {
        if let engine { engine.postedFromHere(message) } else { store.upsertMessage(message) }
        if let here, message.channelId != here { notice = tr("\(workflowTarget(message.channelId)) に投稿しました") }
    }
}

/// One open form's submit (WORKFLOWS.md §8 4.): one `client_msg_id` for the life of the form, so pressing 投稿 again after
/// a failure never posts twice (the server answers a retry with the first message).
@MainActor
final class WorkflowSubmitter {
    enum Outcome: Equatable {
        case posted(MessageOut)
        /// 400 workflow_values_invalid: a reason per field.
        case invalid([String: String])
        case failed(String)
    }

    let clientMsgId: String
    private let api: WorkflowApi

    init(api: WorkflowApi, clientMsgId: String = UUID().uuidString.lowercased()) {
        self.api = api
        self.clientMsgId = clientMsgId
    }

    func submit(_ workflow: WorkflowOut, values: [String: Workflows.Value]) async -> Outcome {
        switch Workflows.clean(workflow.fields, form: values) {
        case .invalid(let errors):
            return .invalid(errors)
        case .ok(let cleaned):
            do {
                let message = try await api.submitWorkflow(id: workflow.id, clientMsgId: clientMsgId, values: cleaned.mapValues(\.json))
                return .posted(message)
            } catch let invalid as WorkflowValuesInvalid {
                return .invalid(invalid.fields)
            } catch {
                return .failed(ErrorMessages.text(for: error))
            }
        }
    }
}
