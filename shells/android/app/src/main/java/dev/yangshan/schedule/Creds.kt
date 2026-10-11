package dev.yangshan.schedule

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys

/**
 * 账号密码只进加密的 SharedPreferences（AES256-GCM，主密钥在 Android Keystore 里），
 * **绝不写进明文文件、绝不进日志、绝不上传**。
 * 与 Windows 壳的 CredStore（CredWriteW/CredReadW）是同一个角色。
 */
object Creds {

    private const val FILE = "yangshan_secure"
    private const val K_USER = "username"
    private const val K_PASS = "password"
    private const val K_REMEMBER = "remember"

    @Volatile
    private var cached: SharedPreferences? = null

    private fun prefs(ctx: Context): SharedPreferences {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            // security-crypto 1.0.0 里还没有 MasterKey 这个类（它是 1.1.0-alpha 才加的），
            // 且这个版本的 EncryptedSharedPreferences.create 签名是
            // create(fileName, masterKeyAlias, context, ...)。所以用同一套 Keystore
            // 主密钥的老 API MasterKeys —— 它被标了 @Deprecated，但在这个版本上是唯一
            // 稳定的写法，效果完全相同：AES256-GCM 主密钥存在 Android Keystore 里。
            @Suppress("DEPRECATION")
            val alias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
            @Suppress("DEPRECATION")
            val p = EncryptedSharedPreferences.create(
                FILE,
                alias,
                ctx.applicationContext,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            cached = p
            return p
        }
    }

    /** 用户有没有勾「记住账号」。默认勾上 —— 每小时自动更新要靠它。 */
    fun remember(ctx: Context): Boolean = prefs(ctx).getBoolean(K_REMEMBER, true)

    fun setRemember(ctx: Context, value: Boolean) {
        prefs(ctx).edit().putBoolean(K_REMEMBER, value).apply()
        if (!value) clear(ctx)
    }

    fun save(ctx: Context, user: String, pass: String) {
        prefs(ctx).edit().putString(K_USER, user).putString(K_PASS, pass).apply()
    }

    fun load(ctx: Context): Pair<String, String>? {
        val p = prefs(ctx)
        val u = p.getString(K_USER, null) ?: return null
        val w = p.getString(K_PASS, null) ?: return null
        return u to w
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().remove(K_USER).remove(K_PASS).apply()
    }
}

/**
 * 非机密的本地状态。课表本体也放这儿 —— 它不是密钥，
 * 但要能离线打开、而且要能在后台刷新时被 Worker 写进来。
 */
object Store {

    private const val FILE = "yangshan_state"
    private const val K_RAW = "raw"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** 上一次抓到的原始结果（YSRAW1- 串），内核启动时会把它读回去。 */
    fun raw(ctx: Context): String? = prefs(ctx).getString(K_RAW, null)

    fun saveRaw(ctx: Context, raw: String) {
        prefs(ctx).edit().putString(K_RAW, raw).apply()
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().clear().apply()
    }
}
