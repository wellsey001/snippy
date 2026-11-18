package com.wellsey001.snippy;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SnippySavePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
