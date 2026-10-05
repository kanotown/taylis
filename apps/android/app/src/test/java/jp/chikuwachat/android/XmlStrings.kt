package jp.chikuwachat.android

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

/**
 * The app's string resources read straight from the res/values directories (JVM unit tests have no Android resources). Follows aapt's
 * rules for a value: a double-quoted value keeps its whitespace, otherwise runs of whitespace collapse and the ends are
 * trimmed; `\n`, `\t`, `\'`, `\"`, `\\`, `\@`, `\?` unescape.
 */
object XmlStrings {
    class Table(val strings: Map<String, String>, val plurals: Map<String, Map<String, String>>)

    val resDir: File by lazy {
        listOf("src/main/res", "app/src/main/res", "apps/android/app/src/main/res").map(::File).firstOrNull { it.isDirectory }
            ?: error("res directory not found from ${File(".").absolutePath}")
    }

    /** The resources of one values directory ("values", "values-en", "values-b+zh+Hans"). */
    fun load(dir: String): Table {
        val strings = LinkedHashMap<String, String>()
        val plurals = LinkedHashMap<String, Map<String, String>>()
        val files = File(resDir, dir).listFiles { f -> f.name.endsWith(".xml") }?.sortedBy { it.name } ?: emptyList()
        for (file in files) {
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
            val root = doc.documentElement
            if (root.tagName != "resources") continue
            val children = root.childNodes
            for (i in 0 until children.length) {
                val node = children.item(i) as? Element ?: continue
                when (node.tagName) {
                    "string" -> {
                        if (node.getAttribute("translatable") == "false" && dir != "values") continue
                        strings[node.getAttribute("name")] = value(node.textContent)
                    }
                    "plurals" -> {
                        val items = LinkedHashMap<String, String>()
                        val list = node.getElementsByTagName("item")
                        for (j in 0 until list.length) {
                            val item = list.item(j) as Element
                            items[item.getAttribute("quantity")] = value(item.textContent)
                        }
                        plurals[node.getAttribute("name")] = items
                    }
                }
            }
        }
        return Table(strings, plurals)
    }

    /** Whether a string is marked translatable="false" (in values/). */
    fun untranslatable(): Set<String> {
        val out = HashSet<String>()
        File(resDir, "values").listFiles { f -> f.name.endsWith(".xml") }?.forEach { file ->
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
            val list = doc.documentElement.getElementsByTagName("string")
            for (i in 0 until list.length) {
                val node = list.item(i) as Element
                if (node.getAttribute("translatable") == "false") out += node.getAttribute("name")
            }
        }
        return out
    }

    fun value(raw: String): String {
        val out = StringBuilder()
        var quoted = false
        var i = 0
        while (i < raw.length) {
            val c = raw[i]
            when {
                c == '\\' && i + 1 < raw.length -> {
                    when (val n = raw[i + 1]) {
                        'n' -> out.append('\n')
                        't' -> out.append('\t')
                        'u' -> { out.append(raw.substring(i + 2, i + 6).toInt(16).toChar()); i += 4 }
                        else -> out.append(n)
                    }
                    i += 2
                    continue
                }
                c == '"' -> quoted = !quoted
                !quoted && c.isWhitespace() -> {
                    if (out.isNotEmpty() && out.last() != ' ') out.append(' ')
                }
                else -> out.append(c)
            }
            i++
        }
        return if (raw.trimStart().startsWith("\"")) out.toString() else out.toString().trim()
    }
}

/** The test resolver of [L10n] (registered in META-INF/services): the Japanese default resources, by R field name. */
class XmlStringsResolver : L10n.Resolver {
    private val table = XmlStrings.load("values")
    private val names: Map<Int, String> by lazy { fields("string") }
    private val pluralNames: Map<Int, String> by lazy { fields("plurals") }

    private fun fields(kind: String): Map<Int, String> =
        Class.forName("jp.chikuwachat.android.R\$$kind").fields.associate { it.getInt(null) to it.name }

    override fun string(id: Int): String {
        val name = names[id] ?: error("unknown string id $id")
        return table.strings[name] ?: error("string $name is not in values/")
    }

    override fun plural(id: Int, count: Int): String {
        val name = pluralNames[id] ?: error("unknown plurals id $id")
        val items = table.plurals[name] ?: error("plurals $name is not in values/")
        return items["other"] ?: items.values.first()
    }

    override val language: String get() = "ja"
}
