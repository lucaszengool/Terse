package com.pruneai.terse

import android.app.Application

class TerseApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        lateinit var instance: TerseApplication
            private set
    }
}
