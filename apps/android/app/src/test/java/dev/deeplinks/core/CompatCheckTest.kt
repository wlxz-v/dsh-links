package dev.deeplinks.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CompatCheckTest {

    @Test
    fun missingCompatReturnsLegacyPlugin() {
        assertNull(parsePluginCompat(null))
        assertEquals(
            CompatStatus.LegacyPlugin,
            checkCompatibility("0.5.0-beta.27", null),
        )
    }

    @Test
    fun olderPluginVersionReturnsPluginTooOld() {
        val info = PluginCompatInfo(pluginVersion = "0.1.0-beta.19", minAppVersion = "0.5.0-beta.27")
        assertEquals(
            CompatStatus.PluginTooOld(current = "0.1.0-beta.19", recommended = "0.1.0-beta.20"),
            checkCompatibility("0.5.0-beta.27", info, minRecommendedPluginVersion = "0.1.0-beta.20"),
        )
    }

    @Test
    fun newerMinAppVersionReturnsAppTooOld() {
        val info = PluginCompatInfo(pluginVersion = "0.1.0-beta.21", minAppVersion = "0.5.0-beta.28")
        assertEquals(
            CompatStatus.AppTooOld(current = "0.5.0-beta.27", required = "0.5.0-beta.28"),
            checkCompatibility("0.5.0-beta.27", info),
        )
    }

    @Test
    fun matchingVersionsReturnCompatible() {
        val parsed = parsePluginCompat(
            JSONObject("""{"pluginVersion":"0.1.0-beta.20","minAppVersion":"0.5.0-beta.27","protocolVersion":1}"""),
        )
        assertEquals(
            CompatStatus.Compatible,
            checkCompatibility("0.5.0-beta.27", parsed),
        )
    }
}
