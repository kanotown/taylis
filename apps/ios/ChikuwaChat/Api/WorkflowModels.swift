import Foundation

/// M95 (docs/WORKFLOWS.md §8): the workflow models the phone reads. Phones only run workflows (the list a channel offers,
/// one workflow, the form's submit); making and editing them stays on the desktop and the web (§8 5.).

/// `MessageOut.workflow` (D4): the workflow whose form posted the message, by its name when it was posted.
struct MessageWorkflow: Codable, Equatable {
    let id: String
    let name: String
}

/// What a field starts with (§3.1), filled in by the device that opens the form.
struct WorkflowFieldDefault: Codable, Equatable {
    /// literal / today / me / next_weekday
    let kind: String
    /// A literal's value: a string, or a checkbox's bool.
    var value: JSONValue? = nil
    /// 0 = Monday (next_weekday).
    var weekday: Int? = nil
    /// "HH:MM" for a datetime field (09:00 when left out).
    var time: String? = nil
}

/// One field of a workflow's form (§3.1).
struct WorkflowField: Codable, Equatable, Identifiable {
    let key: String
    let label: String
    /// text / textarea / date / time / datetime / select / user / checkbox
    let type: String
    var required = false
    var help = ""
    var options: [String] = []
    var multiple = false
    var defaultValue: WorkflowFieldDefault? = nil

    var id: String { key }

    enum CodingKeys: String, CodingKey {
        case key, label, type, required, help, options, multiple
        case defaultValue = "default"
    }

    init(key: String, label: String, type: String, required: Bool = false, help: String = "", options: [String] = [],
         multiple: Bool = false, defaultValue: WorkflowFieldDefault? = nil) {
        self.key = key
        self.label = label
        self.type = type
        self.required = required
        self.help = help
        self.options = options
        self.multiple = multiple
        self.defaultValue = defaultValue
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(String.self, forKey: .label)
        type = try c.decode(String.self, forKey: .type)
        required = try c.decodeIfPresent(Bool.self, forKey: .required) ?? false
        help = try c.decodeIfPresent(String.self, forKey: .help) ?? ""
        options = try c.decodeIfPresent([String].self, forKey: .options) ?? []
        multiple = try c.decodeIfPresent(Bool.self, forKey: .multiple) ?? false
        defaultValue = try? c.decodeIfPresent(WorkflowFieldDefault.self, forKey: .defaultValue)
    }
}

/// `WorkflowOut` (§4). `runBlocked`: why I cannot submit it (disabled / archived / not_a_member / posting_restricted).
struct WorkflowOut: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    var emoji: String? = nil
    var description = ""
    let channelId: String
    var offeredChannelIds: [String] = []
    var fields: [WorkflowField] = []
    let template: String
    var enabled = true
    /// 「確認を求める」 (WORKFLOWS.md §11): off, a workflow without fields posts as soon as it is chosen. An older server
    /// leaves it out, and those workflows always asked.
    var confirm = true
    var canManage = false
    var canRun = true
    var runBlocked: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, name, emoji, description, channelId, offeredChannelIds, fields, template, enabled, confirm, canManage, canRun, runBlocked
    }

    init(id: String, name: String, emoji: String? = nil, description: String = "", channelId: String, offeredChannelIds: [String] = [],
         fields: [WorkflowField] = [], template: String, enabled: Bool = true, confirm: Bool = true, canManage: Bool = false,
         canRun: Bool = true, runBlocked: String? = nil) {
        self.id = id
        self.name = name
        self.emoji = emoji
        self.description = description
        self.channelId = channelId
        self.offeredChannelIds = offeredChannelIds
        self.fields = fields
        self.template = template
        self.enabled = enabled
        self.confirm = confirm
        self.canManage = canManage
        self.canRun = canRun
        self.runBlocked = runBlocked
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        channelId = try c.decode(String.self, forKey: .channelId)
        offeredChannelIds = try c.decodeIfPresent([String].self, forKey: .offeredChannelIds) ?? []
        fields = try c.decodeIfPresent([WorkflowField].self, forKey: .fields) ?? []
        template = try c.decode(String.self, forKey: .template)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        confirm = try c.decodeIfPresent(Bool.self, forKey: .confirm) ?? true
        canManage = try c.decodeIfPresent(Bool.self, forKey: .canManage) ?? false
        canRun = try c.decodeIfPresent(Bool.self, forKey: .canRun) ?? true
        runBlocked = try c.decodeIfPresent(String.self, forKey: .runBlocked)
    }

    /// The menu's mark (⚡ when the workflow has no emoji of its own).
    var mark: String { emoji ?? Workflows.defaultEmoji }

    /// Choosing it posts at once, without the form: 「確認」 off, nothing to fill, and I can run it (as on the desktop).
    var postsWithoutAsking: Bool { !confirm && fields.isEmpty && canRun && runBlocked == nil }
}

/// 400 workflow_values_invalid with its `details.fields` (key → required / invalid / too_long / not_an_option /
/// user_not_found): the form shows each under its field.
struct WorkflowValuesInvalid: Error, Equatable {
    let fields: [String: String]
}

/// The calls the phone makes (ApiClient; tests pass a fake).
protocol WorkflowApi: AnyObject {
    /// The workflows a channel offers (the menu and `/` candidates), by name; disabled ones too.
    func channelWorkflows(channelId: String) async throws -> [WorkflowOut]
    func workflow(id: String) async throws -> WorkflowOut
    /// 201 for a new message, 200 with the same message for a retry with the same `clientMsgId`.
    func submitWorkflow(id: String, clientMsgId: String, values: [String: JSONValue]) async throws -> MessageOut
}
