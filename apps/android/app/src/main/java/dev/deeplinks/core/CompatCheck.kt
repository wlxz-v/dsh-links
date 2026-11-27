package dev.deeplinks.core

import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

const val MIN_RECOMMENDED_PLUGIN_VERSION = "0.1.0-beta.20"

data class PluginCompatInfo(
    val pluginVersion: String = "",
    val minAppVersion: String = "",
    val protocolVersion: Int = 1,
)

sealed interface CompatStatus {
    data object Compatible : CompatStatus
    data class PluginTooOld(val current: String, val recommended: String) : CompatStatus
    data class AppTooOld(val current: String, val required: String) : CompatStatus
    data object LegacyPlugin : CompatStatus
}

fun parsePluginCompat(obj: JSONObject?): PluginCompatInfo? {
    if (obj == null) return null
    val pluginVersion = obj.optString("pluginVersion", "").trim()
    val minAppVersion = obj.optString("minAppVersion", "").trim()
    val protocolVersion = obj.optInt("protocolVersion", 1)
    if (pluginVersion.isEmpty() && minAppVersion.isEmpty()) return null
    return PluginCompatInfo(
        pluginVersion = pluginVersion,
        minAppVersion = minAppVersion,
        protocolVersion = protocolVersion,
    )
}

fun checkCompatibility(
    appVersion: String,
    compat: PluginCompatInfo?,
    minRecommendedPluginVersion: String = MIN_RECOMMENDED_PLUGIN_VERSION,
): CompatStatus {
    if (compat == null || compat.pluginVersion.isBlank()) return CompatStatus.LegacyPlugin
    if (compat.minAppVersion.isNotBlank() && compareVersions(compat.minAppVersion, appVersion) > 0) {
        return CompatStatus.AppTooOld(current = appVersion, required = compat.minAppVersion)
    }
    if (compareVersions(minRecommendedPluginVersion, compat.pluginVersion) > 0) {
        return CompatStatus.PluginTooOld(
            current = compat.pluginVersion,
            recommended = minRecommendedPluginVersion,
        )
    }
    return CompatStatus.Compatible
}

object HostCompatCache {
    private val byHost = ConcurrentHashMap<String, CompatStatus>()

    fun put(slotKey: String, status: CompatStatus) {
        if (slotKey.isBlank()) return
        byHost[slotKey] = status
    }

    fun status(slotKey: String): CompatStatus? =
        if (slotKey.isBlank()) null else byHost[slotKey]

    fun clearHost(slotKey: String) {
        if (slotKey.isBlank()) return
        byHost.remove(slotKey)
    }

    fun clear() {
        byHost.clear()
    }
}
