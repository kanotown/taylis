package jp.chikuwachat.android.ui

import android.content.ActivityNotFoundException
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.FormatListBulleted
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.DataObject
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.FormatBold
import androidx.compose.material.icons.outlined.FormatItalic
import androidx.compose.material.icons.outlined.FormatListNumbered
import androidx.compose.material.icons.outlined.FormatQuote
import androidx.compose.material.icons.outlined.FormatStrikethrough
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.EventAvailable
import androidx.compose.material.icons.outlined.Poll
import androidx.compose.material.icons.outlined.PostAdd
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Title
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import jp.chikuwachat.android.api.TemplateOut
import jp.chikuwachat.android.api.WorkflowOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.SendOptions
import kotlinx.coroutines.launch
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/**
 * Shared composer: drafts and in-flight uploads stay bound to the original conversation.
 * The draft lives in the Store, so `version` must change for the field to show what was typed
 * (strong skipping would otherwise skip this composable: `controller` is always the same instance).
 *
 * 仕上げ B (MOBILE_POLISH C2 / C11, MUI-5; the same shape as iOS ComposerView): at rest a ＋ and a full-width capsule
 * 「#name へのメッセージ」 (send shows inside it once there is something to send); while the input has the focus it
 * takes the whole width, grows to [MAX_LINES] lines (then scrolls), and a row of tools goes under it: ＋ (a sheet:
 * photos, camera, file, poll, template, send later), @, emoji, Aa (formatting), `/`, 🚩 (top-level posts) and send.
 * A long press on send is 「後で送信」.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ConversationComposer(controller: AppController, channelId: String, version: Int, parentId: String? = null) {
    val store = controller.store
    val state = remember(version, channelId, parentId) { store.draft(channelId, parentId) }
    // M28c: what is typed lives here and is written through to the Store's draft quietly (a keystroke bumped the version,
    // and the whole screen recomposed: every row parsed its body again, the timeline was built again). The field follows
    // the Store when the draft changes under it (sent, scheduled, a slash command, a draft from another device), and the
    // version is bumped once when the composer leaves, so the list's 「下書き」 count sees the quiet writes.
    // M30: a TextFieldValue, so text put in from outside (a template, a completion) leaves the cursor at its end.
    var field by remember(channelId, parentId) { mutableStateOf(TextFieldValue(state.text, TextRange(state.text.length))) }
    LaunchedEffect(state.text) { if (state.text != field.text) field = TextFieldValue(state.text, TextRange(state.text.length)) }
    DisposableEffect(channelId, parentId) { onDispose { store.notifyChanged() } }
    val draft = field.text
    val pendingUploads = state.attachments
    val uploading = store.uploading(channelId, parentId)
    fun setField(value: TextFieldValue) {
        val changed = value.text != field.text
        field = value
        if (!changed) return  // only the cursor or the IME's composition moved
        store.setDraft(channelId, parentId, quiet = true) { it.copy(text = value.text) }
        if (value.text.isNotBlank()) controller.engine?.sendTyping(channelId, parentId) // §5.2, throttled by the engine
    }
    fun setText(value: String) = setField(TextFieldValue(value, TextRange(value.length)))
    // M37: a conversation opened from ✏️ 新しいメッセージ starts with the cursor here (and the keyboard up).
    val inputFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    /** 仕上げ B: the tools row shows while the input has the focus (iOS: while it has the keyboard). */
    var focused by remember(channelId, parentId) { mutableStateOf(false) }
    LaunchedEffect(controller.composerFocus, channelId, parentId) {
        if (parentId != null || controller.composerFocus != channelId) return@LaunchedEffect
        // After the picker's window has gone and the field is placed: a request before either does nothing. Cleared
        // only then: clearing it is a change of this effect's key, which would cancel it.
        kotlinx.coroutines.delay(COMPOSER_FOCUS_DELAY_MS)
        runCatching { inputFocus.requestFocus() }
        controller.composerFocus = null
    }
    /** Text put in by a tool (format, @, emoji, template): the input keeps (or takes back) the cursor and the keyboard. */
    fun edit(result: ComposerFormat.Result) {
        setField(TextFieldValue(result.text, TextRange(result.start, result.end)))
        runCatching { inputFocus.requestFocus() }
        keyboard?.show()
    }
    fun insertAtCursor(text: String) = edit(ComposerText.insert(field.text, field.selection.start, field.selection.end, text))
    val channelState = store.channel(channelId)
    val templates = Templates.ordered(store.templates.values, inTimes = channelState?.channel?.isTimes == true)
    fun insertTemplate(template: TemplateOut) {
        val value = Templates.insertButton(draft, template.body, LocalDate.now())
        edit(ComposerFormat.Result(value, value.length, value.length))
    }
    // M95 (WORKFLOWS.md §8 2.-3.): the workflows this channel offers (`/name`, `/wf name`, ＋ → ワークフロー); not in a
    // thread's composer (the post is a top-level one in the target) nor in a DM. Read once the input starts with `/`.
    val offersWorkflows = parentId == null && channelState?.channel?.type.let { it == "public" || it == "private" }
    var workflowList by remember(channelId) { mutableStateOf<List<WorkflowOut>>(emptyList()) }
    val slashTyped = offersWorkflows && Workflows.mayBeCommand(draft)
    LaunchedEffect(channelId, slashTyped) {
        if (slashTyped) controller.channelWorkflows(channelId).onSuccess { workflowList = it }
    }
    /** `/name` or a candidate of a workflow: what was typed goes (unless it changed meanwhile) and the form opens. */
    fun runWorkflow(workflow: WorkflowOut, typed: String) {
        store.setDraft(channelId, parentId) { if (it.text == typed) it.copy(text = "") else it }
        controller.openWorkflow(workflow, channelId)
    }
    val maxAttachments = store.limits?.maxAttachmentsPerMessage ?: 10
    /** Uploads into this draft; [cleanup] runs once each upload is over (the camera's file). */
    fun uploadPicked(uris: List<android.net.Uri>, cleanup: () -> Unit = {}) {
        if (uris.isEmpty()) return
        if (pendingUploads.size + uploading + uris.size > maxAttachments) {
            controller.error = L10n.str(R.string.composer_you_can_attach_up_to_files, maxAttachments)
            cleanup()
            return
        }
        store.trackUpload(channelId, parentId, uris.size)
        uris.forEach { uri -> controller.scope.launch {
            try {
                controller.uploadAttachment(uri).onSuccess { attachment ->
                    store.setDraft(channelId, parentId) { it.copy(attachments = it.attachments + attachment) }
                }
            } finally {
                store.trackUpload(channelId, parentId, -1)
                cleanup()
            }
        } }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uploadPicked(it) }
    val mediaPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { uploadPicked(it) }
    // 仕上げ B (C11): 「カメラ」, the camera app's photo written to the cache through the FileProvider (no permission:
    // the camera app takes it), uploaded as a picked photo is, then removed.
    val openCamera = rememberCameraCapture(controller) { uri, cleanup -> uploadPicked(listOf(uri), cleanup) }
    val hasCamera = openCamera != null
    Column {
        val query = Mentions.query(draft)
        val candidates = if (query != null) Mentions.candidates(query, store.users.values, store.groups.values, aiBotIds = controller.aiBotIds) else emptyList()
        // `:tada` completes to an emoji (M11f) when no mention is being typed.
        val emojiHits = if (candidates.isEmpty()) Emoji.query(draft)?.let { q ->
            // M100: also by label and keywords (":ありがとう" finds :hpd-bow:).
            val found = CustomEmoji.candidates(q, store.customEmoji.values)
            (found.map { EmojiEntry(shortcode = it.name, glyph = ":${it.name}:", category = "custom", keywords = it.label ?: "") } + Emoji.candidates(q)).take(8)
        } ?: emptyList() else emptyList()
        var pickingEmoji by rememberSaveable { mutableStateOf(false) }
        if (pickingEmoji) EmojiPickerSheet(recent = QuickReactions.read(controller.prefs), store = store, onNeedImage = { controller.loadEmojiImage(it) }, onNeedPackTab = { controller.loadPackTab(it) }, onDismiss = { pickingEmoji = false }, onPick = { pickingEmoji = false; QuickReactions.remember(controller.prefs, it); insertAtCursor(it) })
        if (emojiHits.isNotEmpty()) {
            LazyRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(emojiHits, key = { it.shortcode }) { entry ->
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.clickable { QuickReactions.remember(controller.prefs, entry.glyph); setText(Emoji.complete(draft, entry.glyph)) }) {
                        val custom = if (entry.category == "custom") store.customEmoji[entry.shortcode] else null
                        if (custom != null) {
                            // The image (or text pill) and its label, not `:name:` twice.
                            val image = store.emojiImages[custom.id]
                            if (image == null) controller.loadEmojiImage(custom)
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                                if (image != null) EmojiImage(image, store.emojiAnimations[custom.id], contentDescription = null, modifier = Modifier.height(20.dp).width((20 * CustomEmoji.aspect(custom)).dp))
                                Text("  " + (custom.label ?: ":${custom.name}:"), style = MaterialTheme.typography.labelLarge)
                            }
                        } else {
                            Text(entry.glyph + "  :" + entry.shortcode + ":", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                        }
                    }
                }
            }
        }
        // `/st` at the very start offers the slash commands (M13b).
        val commandHits = if (candidates.isEmpty() && emojiHits.isEmpty()) SlashCommands.candidates(draft) else emptyList()
        // M30: the templates after the built-in commands; picking one puts its body in at once (`/` alone: the input is empty).
        val templateHits = if (candidates.isEmpty() && emojiHits.isEmpty()) SlashCommands.prefix(draft)?.let { Templates.candidates(templates, it) } ?: emptyList() else emptyList()
        // M95: then the workflows (「⚡ /name」, or `/wf name` for a name with spaces); picking one opens its form.
        val workflowHits = if (offersWorkflows && candidates.isEmpty() && emojiHits.isEmpty()) Workflows.candidates(draft, workflowList) else emptyList()
        if (commandHits.isNotEmpty() || templateHits.isNotEmpty() || workflowHits.isNotEmpty()) {
            LazyRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(commandHits, key = { it.name }) { command ->
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.clickable { setText("/" + command.name + " ") }) {
                        Text(command.usage + "  " + command.description, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
                items(templateHits, key = { "template:" + it.id }) { template ->
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.tertiaryContainer, modifier = Modifier.clickable { setText(Templates.expand(template.body, LocalDate.now())) }) {
                        Text("/" + template.name + "  " + Templates.kindLabel(template), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
                items(workflowHits, key = { "workflow:" + it.id }) { workflow ->
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.tertiaryContainer, modifier = Modifier.clickable { runWorkflow(workflow, draft) }) {
                        val command = if (workflow.name.any { it.isWhitespace() }) "/wf " + workflow.name else "/" + workflow.name
                        Text(
                            workflowEmoji(workflow) + " " + command + "  " + workflow.description.ifBlank { stringResource(R.string.common_workflow) } + if (!workflow.canRun) stringResource(R.string.composer_unavailable) else "",
                            style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(max = 320.dp).padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                }
            }
        }
        if (candidates.isNotEmpty()) {
            LazyRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(candidates, key = { it.username }) { candidate ->
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.clickable { setText(Mentions.complete(draft, candidate.username)) }) {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                            Text("@" + candidate.username + "  " + candidate.label, style = MaterialTheme.typography.labelLarge)
                            if (candidate.ai) AiBadge(Modifier.padding(start = 6.dp)) // M66
                        }
                    }
                }
            }
        }
        PendingAttachments(pendingUploads, controller, uploading) { removed -> store.setDraft(channelId, parentId) { it.copy(attachments = it.attachments - removed) } }
        // M15c: "also send to the channel" for a thread reply; unticked again after each send (Slack). The toggles below
        // are saveable (M28c): a rotation reset them.
        var alsoInChannel by rememberSaveable(channelId, parentId) { mutableStateOf(false) }
        val channel = store.channel(channelId)
        val canShare = parentId != null && channel?.canPostTopLevel(isAdmin = store.me?.role == "admin") == true
        if (canShare) {
            // 2026-10-06 (as on iOS): only the box and its label take the tap (a 48 dp tall target as wide as they are), and
            // a gap keeps it off the input below: a tap at the input's top edge used to tick it.
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(start = 8.dp, bottom = 8.dp).heightIn(min = TouchTarget.MIN)
                    .toggleable(value = alsoInChannel, role = Role.Checkbox, onValueChange = { alsoInChannel = it })
                    .padding(horizontal = 4.dp),
            ) {
                Checkbox(checked = alsoInChannel, onCheckedChange = null)
                Text(
                    if (channel?.channel?.isDm == true) stringResource(R.string.composer_also_send_to_the_conversation) else stringResource(R.string.composer_also_send_to, channel?.channel?.name ?: ""),
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
        // M15e: priority and "ask for acknowledgement" for a top-level post; cleared after each send.
        var priority by rememberSaveable(channelId, parentId) { mutableStateOf<String?>(null) }
        var ackRequested by rememberSaveable(channelId, parentId) { mutableStateOf(false) }
        var priorityOpen by remember { mutableStateOf(false) }
        if (priority != null || ackRequested) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(start = 16.dp, top = 6.dp)) {
                priority?.let { PriorityLabel(it) }
                if (ackRequested) Text(stringResource(R.string.composer_ask_for_acknowledgement), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                // M28c: a 48 dp touch target around the small link.
                Text(
                    stringResource(R.string.common_remove), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.touchTarget { source -> Modifier.clickable(interactionSource = source, indication = null) { priority = null; ackRequested = false } },
                )
            }
        }
        // 「アンケートを作成」 (testers): from the ＋ sheet, or /poll alone.
        var pollOpen by rememberSaveable { mutableStateOf(false) }
        if (pollOpen) PollDialog(
            onDismiss = { pollOpen = false },
            onCreate = { question, options, multiple, anonymous -> controller.createPoll(channelId, parentId, question, options, multiple, anonymous) },
            launch = { work -> controller.scope.launch { work() } },
        )
        // M54 「日程調整を作成」: from the ＋ sheet, or /日程 (with the dates typed after it as the candidates). Saveable as
        // strings (SchedulePollInitial.encode) so a rotation keeps it open with what it started with.
        var scheduleForm by rememberSaveable { mutableStateOf<List<String>?>(null) }
        scheduleForm?.let { fields ->
            SchedulePollForm(
                initial = remember(fields) { SchedulePollInitial.decode(fields) },
                onDismiss = { scheduleForm = null },
                onCreate = { question, slots, anonymous ->
                    controller.createSchedulePoll(channelId, parentId, question, slots.map { SchedulePolls.slotToIn(it) }, java.time.ZoneId.systemDefault().id, anonymous)
                },
                launch = { work -> controller.scope.launch { work() } },
            )
        }
        // M12d 「後で送信」: the same draft, posted by the server at the chosen time. 仕上げ B: from a long press on send or
        // the ＋ sheet; the presets drop down from send.
        var scheduleOpen by remember { mutableStateOf(false) }
        var customOpen by rememberSaveable { mutableStateOf(false) }
        // Codex audit C2: one key per schedule, kept while the same draft is scheduled again after a failure; no
        // second request while one is on its way.
        var scheduling by remember { mutableStateOf(false) }
        var scheduleKey by remember { mutableStateOf<Pair<String, String>?>(null) }
        val canSend = uploading == 0 && (draft.isNotBlank() || pendingUploads.isNotEmpty())
        val canSchedule = !scheduling && canSend
        fun schedule(at: ZonedDateTime) {
            val body = Mentions.encode(straightenCode(draft.trim()), store.users.values, store.groups.values)
            val ids = pendingUploads.map { it.id }
            if (!canSchedule) return
            if (at.isBefore(ZonedDateTime.now().plusMinutes(1))) { controller.error = L10n.str(R.string.common_choose_a_time_at_least_1); return }
            val what = listOf(channelId, parentId, body, ids).toString()
            val key = scheduleKey?.takeIf { it.second == what }?.first ?: java.util.UUID.randomUUID().toString()
            scheduleKey = key to what
            val typed = draft
            scheduling = true
            controller.scope.launch {
                val done = controller.scheduleMessage(channelId, parentId, body, ids, at, key)
                scheduling = false
                if (!done) return@launch
                scheduleKey = null
                // Codex audit C1: what was typed or attached while the request was on its way stays.
                store.setDraft(channelId, parentId) { it.copy(text = if (it.text == typed) "" else it.text, attachments = it.attachments.filterNot { a -> a.id in ids }) }
            }
        }
        if (customOpen) ScheduleDialog(onDismiss = { customOpen = false }) { at -> customOpen = false; schedule(at) }
        fun send() {
            SlashCommands.parse(draft)?.let { command ->  // M13b
                if (!command.known) {
                    // M30: `/name [文]` of a template is not sent: its body (then 文 on the next line) goes into the input.
                    val template = Templates.find(store.templates.values, command.name)
                    if (template != null) { setText(Templates.insertCommand(template.body, command.args, LocalDate.now())); return }
                    // M95: `/name` of a workflow (or `/wf name`) opens its form; the list is read now if it is not here yet.
                    if (offersWorkflows) {
                        val typed = draft
                        controller.scope.launch {
                            controller.channelWorkflows(channelId)
                                .onSuccess { list ->
                                    workflowList = list
                                    val workflow = Workflows.findCommand(command.name, command.args, list)
                                    when {
                                        workflow != null -> runWorkflow(workflow, typed)
                                        command.name == "wf" && command.args.isBlank() -> controller.error = L10n.str(R.string.composer_put_the_workflows_name_after_wf)
                                        command.name == "wf" -> controller.error = L10n.str(R.string.composer_this_channel_has_no_workflow_called, command.args)
                                        else -> controller.error = L10n.str(R.string.common_there_is_no_command_help_lists, command.name)
                                    }
                                }
                                .onFailure {
                                    // A server before M94 has no list (404): the name is simply no command there.
                                    if (it is jp.chikuwachat.android.api.ApiException.Api && it.status == 404 && command.name != "wf") {
                                        controller.error = L10n.str(R.string.common_there_is_no_command_help_lists, command.name)
                                    } else controller.report(it)
                                }
                        }
                        return
                    }
                    controller.error = L10n.str(R.string.common_there_is_no_command_help_lists, command.name)
                    return
                }
                // M54: /日程 opens the scheduling poll's form, with the dates (and times) typed after it as the candidates;
                // arguments that cannot be read keep what was typed, to be corrected, and nothing opens.
                if (command.name == SlashCommands.SCHEDULE) {
                    val read = if (command.args.isBlank()) null else Templates.readSchedule(command.args, LocalDate.now())
                    if (command.args.isNotBlank() && read == null) {
                        controller.error = Templates.SCHEDULE_USAGE
                        return
                    }
                    store.setDraft(channelId, parentId) { jp.chikuwachat.android.sync.Draft() }
                    scheduleForm = (read?.let { SchedulePollInitial(it.question, SchedulePolls.slotsFromEntries(it.entries)) } ?: SchedulePollInitial()).encode()
                    return
                }
                store.setDraft(channelId, parentId) { jp.chikuwachat.android.sync.Draft() }
                if (command.name == "poll" && command.args.isBlank()) { pollOpen = true; return }
                controller.scope.launch { controller.runCommand(command, channelId, parentId) }
                return
            }
            val body = Mentions.encode(straightenCode(draft.trim()), store.users.values, store.groups.values)
            val ids = pendingUploads.map { it.id }
            if (uploading > 0 || (body.isEmpty() && ids.isEmpty())) return
            val maxLength = store.limits?.maxMessageLength ?: 20_000
            if (body.length > maxLength) { controller.error = L10n.plural(R.plurals.composer_message_max_length, maxLength, maxLength); return }
            store.setDraft(channelId, parentId) { jp.chikuwachat.android.sync.Draft() }
            val options = SendOptions(
                alsoInChannel = canShare && alsoInChannel,
                priority = if (parentId == null) priority else null,
                ackRequested = parentId == null && ackRequested,
            )
            alsoInChannel = false
            priority = null
            ackRequested = false
            controller.scope.launch { controller.engine?.send(channelId, body, parentId = parentId, attachmentIds = ids, sendOptions = options) }
        }

        /** Send (tap) and 「後で送信」 (long press), with the presets dropping down from it; a spinner while uploading. */
        @Composable
        fun SendControl(size: Dp) {
            Box(Modifier.size(size + 8.dp), contentAlignment = Alignment.Center) {
                if (uploading > 0) {
                    CircularProgressIndicator(Modifier.size(size - 12.dp), strokeWidth = 2.dp)
                } else {
                    val haptics = LocalHapticFeedback.current
                    Box(
                        Modifier.size(size).alpha(if (canSend) 1f else 0.35f).clip(CircleShape).background(MaterialTheme.colorScheme.primary)
                            .combinedClickable(
                                enabled = canSend, onClickLabel = stringResource(R.string.common_send), onLongClickLabel = stringResource(R.string.common_send_later),
                                onLongClick = { if (canSchedule) { haptics.performHapticFeedback(HapticFeedbackType.LongPress); scheduleOpen = true } },
                                onClick = ::send,
                            )
                            .semantics { contentDescription = L10n.str(R.string.common_send) },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Outlined.ArrowUpward, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(size * 0.62f)) }
                }
                ScheduleMenu(expanded = scheduleOpen, onDismiss = { scheduleOpen = false }, onPick = ::schedule, onCustom = { customOpen = true })
            }
        }

        var plusOpen by remember { mutableStateOf(false) }
        if (plusOpen) PlusSheet(
            hasCamera = hasCamera, templates = templates, canSchedule = canSchedule,
            workflows = if (offersWorkflows) ({ onRun -> ChannelWorkflowList(controller, channelId, onRun) }) else null,
            onWorkflow = { controller.openWorkflow(it, channelId) },
            onDismiss = { plusOpen = false },
            onPhotos = { mediaPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
            onCamera = { openCamera?.invoke() },
            onFile = { picker.launch("*/*") },
            onPoll = { pollOpen = true },
            onSchedulePoll = { scheduleForm = SchedulePollInitial().encode() },
            onTemplate = ::insertTemplate,
            onSchedule = { scheduleOpen = true },
        )
        val placeholder = ComposerText.placeholder(channel?.let { channelTitle(it, store) }, inThread = parentId != null)
        Row(
            Modifier.fillMaxWidth().padding(start = if (focused) 12.dp else 4.dp, end = 12.dp, top = 8.dp, bottom = if (focused) 2.dp else 8.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            if (!focused) {
                IconButton(enabled = uploading == 0, onClick = { plusOpen = true }, modifier = Modifier.size(44.dp)) {
                    Icon(
                        Icons.Filled.AddCircle, contentDescription = stringResource(R.string.composer_attach_and_more),
                        tint = if (uploading == 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(34.dp),
                    )
                }
                Spacer(Modifier.width(4.dp))
            }
            // The capsule: filled, no outline box (C2); one line at rest, growing while typing.
            Row(
                Modifier.weight(1f).heightIn(min = CAPSULE_HEIGHT).clip(RoundedCornerShape(CAPSULE_HEIGHT / 2))
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                    .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(CAPSULE_HEIGHT / 2)),
                verticalAlignment = Alignment.Bottom,
            ) {
                val textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface)
                // T1 (MOBILE_UI.md §12): with a hardware keyboard, Enter sends and Shift+Enter is a new line (HardwareKeys).
                val hardwareKeyboard = HardwareKeys.attached(LocalConfiguration.current)
                BasicTextField(
                    value = field, onValueChange = { setField(it) },
                    modifier = Modifier.weight(1f).align(Alignment.CenterVertically)
                        .padding(start = 16.dp, end = if (!focused && canSend) 4.dp else 16.dp, top = 9.dp, bottom = 9.dp)
                        .focusRequester(inputFocus).onFocusChanged { focused = it.isFocused }
                        .onPreviewKeyEvent { event ->
                            if (!HardwareKeys.isEnter(event.nativeKeyEvent.keyCode)) return@onPreviewKeyEvent false
                            val action = HardwareKeys.enter(hardwareKeyboard, event.isShiftPressed, event.isAltPressed, composing = field.composition != null)
                            if (action == HardwareKeys.EnterAction.NONE) return@onPreviewKeyEvent false
                            if (event.type == KeyEventType.KeyDown) {
                                if (action == HardwareKeys.EnterAction.SEND) send() else insertAtCursor("\n")
                            }
                            true
                        },
                    textStyle = textStyle, maxLines = MAX_LINES,
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    decorationBox = { inner ->
                        Box {
                            if (field.text.isEmpty()) Text(placeholder, style = textStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            inner()
                        }
                    },
                )
                if (!focused && (canSend || uploading > 0)) Box(Modifier.padding(end = 1.dp, bottom = 1.dp)) { SendControl(30.dp) }
            }
        }
        if (focused) {
            // Under the input while typing (iOS toolRow): ＋, @, emoji, Aa, /, 🚩 (top-level posts); send on the right.
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                val tint = MaterialTheme.colorScheme.onSurfaceVariant
                IconButton(enabled = uploading == 0, onClick = { plusOpen = true }) { Icon(Icons.Outlined.AddCircleOutline, contentDescription = stringResource(R.string.composer_attach_and_more), tint = tint) }
                IconButton(onClick = { edit(ComposerText.mention(field.text, field.selection.start, field.selection.end)) }) {
                    Icon(Icons.Outlined.AlternateEmail, contentDescription = stringResource(R.string.common_mention), tint = tint)
                }
                IconButton(onClick = { pickingEmoji = true }) { Icon(Icons.Outlined.EmojiEmotions, contentDescription = stringResource(R.string.common_emoji), tint = tint) }
                Box {
                    var formatOpen by remember { mutableStateOf(false) }
                    IconButton(onClick = { formatOpen = true }, modifier = Modifier.semantics { contentDescription = L10n.str(R.string.composer_formatting) }) {
                        Text("Aa", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = tint)
                    }
                    FormatMenu(formatOpen, onDismiss = { formatOpen = false }) { format ->
                        formatOpen = false
                        edit(format.apply(field.text, field.selection.start, field.selection.end))
                    }
                }
                // `/`: the commands and templates, offered as at the start of the input (M13b, M30).
                IconButton(
                    onClick = { if (draft.isBlank()) edit(ComposerFormat.Result("/", 1, 1)) else insertAtCursor("/") },
                    modifier = Modifier.semantics { contentDescription = L10n.str(R.string.composer_commands) },
                ) { Text("/", style = MaterialTheme.typography.titleLarge, color = tint) }
                if (parentId == null) {
                    Box {
                        IconButton(onClick = { priorityOpen = true }) {
                            Icon(Icons.Outlined.Flag, contentDescription = stringResource(R.string.composer_priority), tint = if (priority != null || ackRequested) MaterialTheme.colorScheme.primary else tint)
                        }
                        PriorityMenu(priorityOpen, { priorityOpen = false }, priority, ackRequested, onPriority = { priority = it }, onToggleAck = { ackRequested = !ackRequested })
                    }
                }
                Spacer(Modifier.weight(1f))
                SendControl(34.dp)
            }
        }
    }
}

/** The input's height at one line; the capsule's ends are half of it. */
private val CAPSULE_HEIGHT = 42.dp

/** How far the input grows before it scrolls (as iOS, `lineLimit(1...6)`). */
private const val MAX_LINES = 6

/** M37: how long the composer waits before taking the focus it was asked for (the picker's window closing first). */
private const val COMPOSER_FOCUS_DELAY_MS = 300L

/** 仕上げ B (C11): where the camera's photo goes before it is uploaded (the FileProvider's `camera/`). */
object CameraCapture {
    const val DIR = "camera"
    private val STAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss")

    /** 「photo_20260930_221605.jpg」: the name the attachment keeps. */
    fun fileName(at: LocalDateTime): String = "photo_" + STAMP.format(at) + ".jpg"

    /** A new file under the cache's `camera/`; photos left there over a day (the app stopped mid-upload) go first. */
    fun newFile(cacheDir: File, at: LocalDateTime): File {
        val dir = File(cacheDir, DIR).apply { mkdirs() }
        val dayAgo = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
        dir.listFiles()?.filter { it.lastModified() < dayAgo }?.forEach { it.delete() }
        return File(dir, fileName(at))
    }
}

/**
 * 仕上げ B (C11), shared with the canvas editor in M58: opens the camera app on a file in the cache (the FileProvider's
 * `camera/`; no permission, the camera app takes the photo) and hands the photo's URI over with a `cleanup` that removes
 * the file once its upload is over. Null when the phone has no camera. The pending file survives a rotation.
 */
@Composable
fun rememberCameraCapture(controller: AppController, onPhoto: (uri: android.net.Uri, cleanup: () -> Unit) -> Unit): (() -> Unit)? {
    val context = LocalContext.current
    val hasCamera = remember { context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }
    var cameraFile by rememberSaveable { mutableStateOf<String?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        val path = cameraFile ?: return@rememberLauncherForActivityResult
        cameraFile = null
        val file = File(path)
        if (!taken || !file.exists() || file.length() == 0L) { file.delete(); return@rememberLauncherForActivityResult }
        onPhoto(FileProvider.getUriForFile(context, context.packageName + ".files", file)) { file.delete() }
    }
    if (!hasCamera) return null
    return {
        val file = CameraCapture.newFile(context.cacheDir, LocalDateTime.now())
        cameraFile = file.path
        try {
            camera.launch(FileProvider.getUriForFile(context, context.packageName + ".files", file))
        } catch (_: ActivityNotFoundException) {
            cameraFile = null
            file.delete()
            controller.error = L10n.str(R.string.composer_couldnt_open_the_camera)
        }
    }
}

/**
 * 仕上げ B (C11, MUI-5): the ＋ sheet, every row with its icon: photos and videos, the camera (when the phone has one),
 * a file, a poll, a scheduling poll (M54), a template (the list opens in the sheet), send later.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlusSheet(
    hasCamera: Boolean,
    templates: List<TemplateOut>,
    canSchedule: Boolean,
    /** M95: the channel's workflow list (null: none offered here, a thread or a DM), and what a picked one does. */
    workflows: (@Composable (onRun: (WorkflowOut) -> Unit) -> Unit)?,
    onWorkflow: (WorkflowOut) -> Unit,
    onDismiss: () -> Unit,
    onPhotos: () -> Unit,
    onCamera: () -> Unit,
    onFile: () -> Unit,
    onPoll: () -> Unit,
    onSchedulePoll: () -> Unit,
    onTemplate: (TemplateOut) -> Unit,
    onSchedule: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var showingTemplates by remember { mutableStateOf(false) }
    var showingWorkflows by remember { mutableStateOf(false) }
    fun close(then: () -> Unit) {
        scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss(); then() }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(bottom = 8.dp)) {
            @Composable
            fun item(label: String, icon: ImageVector, enabled: Boolean = true, action: () -> Unit) {
                val color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = enabled) { action() }.padding(horizontal = 24.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(18.dp))
                    Text(label, color = color, style = MaterialTheme.typography.bodyLarge)
                }
            }
            if (showingWorkflows && workflows != null) {
                // M95: read each time it opens (kept a minute); a greyed row says why it cannot run.
                item(stringResource(R.string.common_workflow), Icons.AutoMirrored.Outlined.ArrowBack) { showingWorkflows = false }
                HorizontalDivider()
                workflows { workflow -> close { onWorkflow(workflow) } }
            } else if (showingTemplates) {
                item(stringResource(R.string.common_templates), Icons.AutoMirrored.Outlined.ArrowBack) { showingTemplates = false }
                HorizontalDivider()
                if (templates.isEmpty()) {
                    Text(
                        stringResource(R.string.composer_no_templates_create_them_in_the), style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp),
                    )
                }
                templates.forEach { template ->
                    Column(Modifier.fillMaxWidth().clickable { close { onTemplate(template) } }.padding(horizontal = 24.dp, vertical = 10.dp)) {
                        Text("/" + template.name + "  " + Templates.kindLabel(template), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            template.body.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty(), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            } else {
                item(stringResource(R.string.composer_photos_videos), Icons.Outlined.PhotoLibrary) { close(onPhotos) }
                if (hasCamera) item(stringResource(R.string.composer_camera), Icons.Outlined.PhotoCamera) { close(onCamera) }
                item(stringResource(R.string.common_files), Icons.AutoMirrored.Outlined.InsertDriveFile) { close(onFile) }
                item(stringResource(R.string.composer_poll), Icons.Outlined.Poll) { close(onPoll) }
                item(stringResource(R.string.common_scheduling_poll), Icons.Outlined.EventAvailable) { close(onSchedulePoll) }
                item(stringResource(R.string.common_templates), Icons.Outlined.PostAdd) { showingTemplates = true }
                if (workflows != null) item(stringResource(R.string.common_workflow), Icons.Outlined.Bolt) { showingWorkflows = true }
                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                item(stringResource(R.string.composer_send_later), Icons.Outlined.Schedule, enabled = canSchedule) { close(onSchedule) }
            }
        }
    }
}

/** 仕上げ B: 「Aa」, the marks put around the selection or at the cursor ([ComposerFormat]). */
@Composable
private fun FormatMenu(expanded: Boolean, onDismiss: () -> Unit, onPick: (ComposerFormat) -> Unit) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        ComposerFormat.entries.forEach { format ->
            DropdownMenuItem(
                text = { Text(format.label) }, onClick = { onPick(format) },
                leadingIcon = { Icon(format.icon(), contentDescription = null) },
            )
        }
    }
}

private fun ComposerFormat.icon(): ImageVector = when (this) {
    ComposerFormat.BOLD -> Icons.Outlined.FormatBold
    ComposerFormat.ITALIC -> Icons.Outlined.FormatItalic
    ComposerFormat.STRIKE -> Icons.Outlined.FormatStrikethrough
    ComposerFormat.CODE -> Icons.Outlined.Code
    ComposerFormat.CODE_BLOCK -> Icons.Outlined.DataObject
    ComposerFormat.HEADING -> Icons.Outlined.Title
    ComposerFormat.QUOTE -> Icons.Outlined.FormatQuote
    ComposerFormat.BULLET -> Icons.AutoMirrored.Outlined.FormatListBulleted
    ComposerFormat.NUMBERED -> Icons.Outlined.FormatListNumbered
    ComposerFormat.LINK -> Icons.Outlined.Link
}

/** M15e: 通常 / 重要 / 緊急 and 「確認を求める」, from the 🚩 in the tools row. */
@Composable
private fun PriorityMenu(expanded: Boolean, onDismiss: () -> Unit, priority: String?, ackRequested: Boolean, onPriority: (String?) -> Unit, onToggleAck: () -> Unit) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        listOf(null to stringResource(R.string.composer_normal), "important" to stringResource(R.string.composer_important), "urgent" to stringResource(R.string.composer_urgent)).forEach { (value, label) ->
            DropdownMenuItem(
                text = { if (value == null) Text(label) else PriorityLabel(value) },
                onClick = { onPriority(value); onDismiss() },
                trailingIcon = { if (priority == value) Icon(Icons.Default.Check, contentDescription = null) },
            )
        }
        HorizontalDivider()
        DropdownMenuItem(text = { Text(stringResource(R.string.composer_ask_for_acknowledgement)) }, onClick = onToggleAck, leadingIcon = { Checkbox(checked = ackRequested, onCheckedChange = null) })
    }
}

/** M12d 「後で送信」: the presets and 「日時を指定…」, dropping down from send (long press, or the ＋ sheet). */
@Composable
private fun ScheduleMenu(expanded: Boolean, onDismiss: () -> Unit, onPick: (ZonedDateTime) -> Unit, onCustom: () -> Unit) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss, modifier = Modifier.widthIn(min = 200.dp)) {
        Text(
            stringResource(R.string.common_send_later), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
        Schedule.presets().forEach { preset ->
            DropdownMenuItem(text = { Text(Schedule.choice(preset)) }, onClick = { onDismiss(); onPick(preset.at) })
        }
        HorizontalDivider()
        DropdownMenuItem(text = { Text(stringResource(R.string.common_pick_a_date_and_time)) }, onClick = { onDismiss(); onCustom() })
    }
}
