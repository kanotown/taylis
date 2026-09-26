package jp.chikuwachat.android.platform

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val Context.settingsStore: DataStore<Preferences> by preferencesDataStore(name = "chikuwa")

/**
 * Small settings (server URL, username) in DataStore, and refresh tokens encrypted with an
 * AES-GCM key that lives in the Android Keystore (SECURITY.md §4: tokens never sit in plain files).
 */
class SecretStore(private val context: Context) {
    private val store get() = context.settingsStore

    suspend fun setting(name: String): String? = store.data.first()[stringPreferencesKey(name)]

    suspend fun putSetting(name: String, value: String?) {
        val key = stringPreferencesKey(name)
        store.edit { if (value == null) it.remove(key) else it[key] = value }
    }

    suspend fun secret(name: String): String? {
        val blob = store.data.first()[stringPreferencesKey("secret:$name")] ?: return null
        return runCatching { decrypt(blob) }.getOrNull()
    }

    suspend fun putSecret(name: String, value: String?) {
        val key = stringPreferencesKey("secret:$name")
        val blob = value?.let { encrypt(it) }
        store.edit { if (blob == null) it.remove(key) else it[key] = blob }
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val encrypted = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(iv + encrypted, Base64.NO_WRAP)
    }

    private fun decrypt(blob: String): String {
        val bytes = Base64.decode(blob, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
        return String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
    }

    private companion object {
        const val ALIAS = "jp.chikuwachat.secrets"
        const val IV_BYTES = 12
    }
}
