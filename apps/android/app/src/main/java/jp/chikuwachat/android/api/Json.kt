package jp.chikuwachat.android.api

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy

/** `snake` for API models (snake_case ⇄ camelCase); `plain` for raw JSON and local storage. */
object Codec {
    @OptIn(ExperimentalSerializationApi::class)
    val snake: Json = Json {
        namingStrategy = JsonNamingStrategy.SnakeCase
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }

    val plain: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }
}
