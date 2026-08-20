/**
 * GENERATED FILE — do not edit.
 *
 * Source:    docs/design/settings-inventory.md (vocabulary version 1)
 * Generator: platform/src/modules/profile/generateVocabulary.mjs
 *
 * RoamingSettingsV1 is defined by http-api.md §11.9 as "exactly the rows of the inventory whose
 * Scope is ROAM". This file IS that projection, machine-derived, so the validator cannot
 * disagree with the design document.
 */
const RAW = {
  "vocabularyVersion": 1,
  "categories": [
    "input",
    "bindings",
    "graphics",
    "audioCaptions",
    "crosshairHud",
    "accessibility",
    "network"
  ],
  "scopes": {
    "sensitivity": "ROAM",
    "adsSensitivity": "ROAM",
    "invertY": "ROAM",
    "toggleAds": "ROAM",
    "toggleCrouch": "ROAM",
    "autoSprint": "ROAM",
    "fov": "ROAM",
    "cameraShake": "ROAM",
    "viewBob": "ROAM",
    "weaponSway": "ROAM",
    "renderScale": "DEVICE",
    "shadows": "DEVICE",
    "shadowQuality": "DEVICE",
    "postFx": "DEVICE",
    "filmGrain": "DEVICE",
    "motionBlur": "DEVICE",
    "vignette": "DEVICE",
    "maxFps": "DEVICE",
    "showFps": "DEVICE",
    "brightness": "DEVICE",
    "flashIntensity": "ROAM",
    "screenEffectIntensity": "ROAM",
    "masterVolume": "DEVICE",
    "sfxVolume": "DEVICE",
    "musicVolume": "DEVICE",
    "uiVolume": "DEVICE",
    "announcerVolume": "DEVICE",
    "subtitles": "ROAM",
    "closedCaptions": "ROAM",
    "subtitleSize": "ROAM",
    "captionBackground": "ROAM",
    "captionDirection": "ROAM",
    "crosshairStyle": "ROAM",
    "crosshairColor": "ROAM",
    "crosshairOpacity": "ROAM",
    "crosshairSize": "ROAM",
    "crosshairThickness": "ROAM",
    "crosshairGap": "ROAM",
    "crosshairOutline": "ROAM",
    "hudScale": "ROAM",
    "hudTextSize": "ROAM",
    "showMinimap": "ROAM",
    "minimapRotation": "ROAM",
    "showDamageNumbers": "ROAM",
    "showKillfeed": "ROAM",
    "showObjectiveMarkers": "ROAM",
    "damageVignette": "ROAM",
    "colorVisionPreset": "ROAM",
    "reduceMotion": "ROAM"
  },
  "roam": {
    "sensitivity": {
      "kind": "number",
      "min": 0.05,
      "max": 10,
      "step": 0.01,
      "unit": null,
      "default": 0.9
    },
    "adsSensitivity": {
      "kind": "number",
      "min": 0.05,
      "max": 4,
      "step": 0.01,
      "unit": "x",
      "default": 0.75
    },
    "invertY": {
      "kind": "boolean",
      "default": false
    },
    "toggleAds": {
      "kind": "enum",
      "values": [
        "hold",
        "toggle"
      ],
      "labels": [
        "Hold",
        "Toggle"
      ],
      "default": "hold"
    },
    "toggleCrouch": {
      "kind": "enum",
      "values": [
        "hold",
        "toggle"
      ],
      "labels": [
        "Hold",
        "Toggle"
      ],
      "default": "hold"
    },
    "autoSprint": {
      "kind": "boolean",
      "default": false
    },
    "fov": {
      "kind": "number",
      "min": 60,
      "max": 120,
      "step": 1,
      "unit": "°",
      "default": 85
    },
    "cameraShake": {
      "kind": "number",
      "min": 0,
      "max": 100,
      "step": 5,
      "unit": "%",
      "default": 100
    },
    "viewBob": {
      "kind": "number",
      "min": 0,
      "max": 100,
      "step": 5,
      "unit": "%",
      "default": 60
    },
    "weaponSway": {
      "kind": "number",
      "min": 0,
      "max": 100,
      "step": 5,
      "unit": "%",
      "default": 100
    },
    "flashIntensity": {
      "kind": "number",
      "min": 0,
      "max": 100,
      "step": 10,
      "unit": "%",
      "default": 100
    },
    "screenEffectIntensity": {
      "kind": "number",
      "min": 0,
      "max": 100,
      "step": 10,
      "unit": "%",
      "default": 100
    },
    "subtitles": {
      "kind": "boolean",
      "default": true
    },
    "closedCaptions": {
      "kind": "boolean",
      "default": false
    },
    "subtitleSize": {
      "kind": "enum",
      "values": [
        "small",
        "default",
        "large",
        "extraLarge"
      ],
      "labels": [
        "Small",
        "Default",
        "Large",
        "Extra large"
      ],
      "default": "default"
    },
    "captionBackground": {
      "kind": "number",
      "min": 40,
      "max": 100,
      "step": 5,
      "unit": "%",
      "default": 75
    },
    "captionDirection": {
      "kind": "boolean",
      "default": true
    },
    "crosshairStyle": {
      "kind": "enum",
      "values": [
        "dynamic",
        "static",
        "dot"
      ],
      "labels": [
        "Dynamic",
        "Static",
        "Dot"
      ],
      "default": "dynamic"
    },
    "crosshairColor": {
      "kind": "color",
      "default": "#8EF7C4"
    },
    "crosshairOpacity": {
      "kind": "number",
      "min": 30,
      "max": 100,
      "step": 5,
      "unit": "%",
      "default": 100
    },
    "crosshairSize": {
      "kind": "number",
      "min": 50,
      "max": 200,
      "step": 5,
      "unit": "%",
      "default": 100
    },
    "crosshairThickness": {
      "kind": "number",
      "min": 1,
      "max": 6,
      "step": 1,
      "unit": "px",
      "default": 2
    },
    "crosshairGap": {
      "kind": "number",
      "min": 0,
      "max": 20,
      "step": 1,
      "unit": "px",
      "default": 6
    },
    "crosshairOutline": {
      "kind": "boolean",
      "default": true
    },
    "hudScale": {
      "kind": "number",
      "min": 70,
      "max": 160,
      "step": 5,
      "unit": "%",
      "default": 100
    },
    "hudTextSize": {
      "kind": "enum",
      "values": [
        "small",
        "default",
        "large",
        "extraLarge"
      ],
      "labels": [
        "Small",
        "Default",
        "Large",
        "Extra large"
      ],
      "default": "default"
    },
    "showMinimap": {
      "kind": "boolean",
      "default": true
    },
    "minimapRotation": {
      "kind": "enum",
      "values": [
        "northUp",
        "playerUp"
      ],
      "labels": [
        "North up",
        "Player up"
      ],
      "default": "playerUp"
    },
    "showDamageNumbers": {
      "kind": "boolean",
      "default": true
    },
    "showKillfeed": {
      "kind": "boolean",
      "default": true
    },
    "showObjectiveMarkers": {
      "kind": "enum",
      "values": [
        "minimal",
        "full"
      ],
      "labels": [
        "Minimal",
        "Full"
      ],
      "default": "full"
    },
    "damageVignette": {
      "kind": "enum",
      "values": [
        "off",
        "low",
        "full"
      ],
      "labels": [
        "Off",
        "Low",
        "Full"
      ],
      "default": "full"
    },
    "colorVisionPreset": {
      "kind": "enum",
      "values": [
        "default",
        "deuteranopia",
        "protanopia",
        "tritanopia"
      ],
      "labels": [
        "Default",
        "Deuteranopia",
        "Protanopia",
        "Tritanopia"
      ],
      "default": "default"
    },
    "reduceMotion": {
      "kind": "boolean",
      "default": null
    }
  },
  "keybinds": {
    "forward": {
      "label": "Move forward",
      "defaultPrimaryLabel": "W",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "back": {
      "label": "Move back",
      "defaultPrimaryLabel": "S",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "left": {
      "label": "Strafe left",
      "defaultPrimaryLabel": "A",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "right": {
      "label": "Strafe right",
      "defaultPrimaryLabel": "D",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "jump": {
      "label": "Jump",
      "defaultPrimaryLabel": "Space",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "sprint": {
      "label": "Sprint",
      "defaultPrimaryLabel": "Left Shift",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "crouch": {
      "label": "Crouch/slide",
      "defaultPrimaryLabel": "Left Ctrl",
      "defaultSecondaryLabel": "C",
      "reserved": false
    },
    "lean": {
      "label": "Lean/contextual lean",
      "defaultPrimaryLabel": "Q",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "fire": {
      "label": "Fire",
      "defaultPrimaryLabel": "Mouse 1",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "aim": {
      "label": "Aim",
      "defaultPrimaryLabel": "Mouse 2",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "reload": {
      "label": "Reload",
      "defaultPrimaryLabel": "R",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "melee": {
      "label": "Melee",
      "defaultPrimaryLabel": "F",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "grenade": {
      "label": "Lethal grenade",
      "defaultPrimaryLabel": "G",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "tacticalEquipment": {
      "label": "Tactical equipment",
      "defaultPrimaryLabel": null,
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "interact": {
      "label": "Interact / plant / defuse / pickup",
      "defaultPrimaryLabel": "E",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "weapon1": {
      "label": "Primary weapon",
      "defaultPrimaryLabel": "1",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "weapon2": {
      "label": "Secondary weapon",
      "defaultPrimaryLabel": "2",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "weapon3": {
      "label": "Tertiary/special",
      "defaultPrimaryLabel": "3",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "nextWeapon": {
      "label": "Next weapon",
      "defaultPrimaryLabel": "Mouse wheel down",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "previousWeapon": {
      "label": "Previous weapon",
      "defaultPrimaryLabel": "Mouse wheel up",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "lastWeapon": {
      "label": "Last weapon",
      "defaultPrimaryLabel": "V",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "killstreak": {
      "label": "Killstreak/action slot",
      "defaultPrimaryLabel": "B",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "inspect": {
      "label": "Inspect weapon",
      "defaultPrimaryLabel": "X",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "scoreboard": {
      "label": "Scoreboard (hold)",
      "defaultPrimaryLabel": "Tab",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "textChat": {
      "label": "Open text chat",
      "defaultPrimaryLabel": "Enter",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "teamChat": {
      "label": "Team chat",
      "defaultPrimaryLabel": "Y",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "tacticalPing": {
      "label": "Tactical ping / ping wheel",
      "defaultPrimaryLabel": "Middle mouse",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "muteCurrentTarget": {
      "label": "Mute current spectator/voice target",
      "defaultPrimaryLabel": null,
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "spectatePrevious": {
      "label": "Spectate previous",
      "defaultPrimaryLabel": "Left arrow",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "spectateNext": {
      "label": "Spectate next",
      "defaultPrimaryLabel": "Right arrow",
      "defaultSecondaryLabel": null,
      "reserved": false
    },
    "pause": {
      "label": "Pause/back",
      "defaultPrimaryLabel": "Escape",
      "defaultSecondaryLabel": null,
      "reserved": true
    }
  }
};

/**
 * `scopes`, `roam` and `keybinds` are looked up with client-supplied keys, so they are
 * prototype-less: a plain object answers `constructor`, `toString` and `__proto__` with a
 * truthy value the inventory never declared, and that value was accepted as a definition.
 */
const lookup = (o) => Object.assign(Object.create(null), o);

export const VOCABULARY = {
  ...RAW,
  scopes: lookup(RAW.scopes),
  roam: lookup(RAW.roam),
  keybinds: lookup(RAW.keybinds),
};

export default VOCABULARY;
