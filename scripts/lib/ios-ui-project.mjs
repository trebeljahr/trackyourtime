import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A standalone simulator UI-test target. No dependency on the shipping target,
// developer identity, or a globally installed project generator.
export function createUITestProject(stage, fixture, config) {
  const objects = {};
  let counter = 0;
  const add = (value) => {
    const id = (++counter).toString(16).padStart(24, "0").toUpperCase();
    objects[id] = value;
    return id;
  };
  const file = (path, type, sourceTree = "<group>") =>
    add({ isa: "PBXFileReference", path, lastKnownFileType: type, sourceTree });
  const swift = file("IPadUITests.swift", "sourcecode.swift");
  const configFile = file("qa-config.json", "text.json");
  const product = file(
    "IPadUITests.xctest",
    "wrapper.cfbundle",
    "BUILT_PRODUCTS_DIR",
  );
  const phase = (isa, refs) =>
    add({
      isa,
      buildActionMask: 2147483647,
      files: refs.map((fileRef) => add({ isa: "PBXBuildFile", fileRef })),
      runOnlyForDeploymentPostprocessing: 0,
    });
  const configuration = (settings) => {
    const build = add({
      isa: "XCBuildConfiguration",
      name: "Debug",
      buildSettings: settings,
    });
    return add({
      isa: "XCConfigurationList",
      buildConfigurations: [build],
      defaultConfigurationIsVisible: 0,
      defaultConfigurationName: "Debug",
    });
  };
  const target = add({
    isa: "PBXNativeTarget",
    name: "IPadUITests",
    productName: "IPadUITests",
    productReference: product,
    productType: "com.apple.product-type.bundle.ui-testing",
    buildRules: [],
    dependencies: [],
    buildPhases: [
      phase("PBXSourcesBuildPhase", [swift]),
      phase("PBXResourcesBuildPhase", [configFile]),
      phase("PBXFrameworksBuildPhase", []),
    ],
    buildConfigurationList: configuration({
      PRODUCT_BUNDLE_IDENTIFIER: "com.ricoslabs.trackyourtime.ipaduitests",
      PRODUCT_NAME: "$(TARGET_NAME)",
      GENERATE_INFOPLIST_FILE: "YES",
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: "2",
      IPHONEOS_DEPLOYMENT_TARGET: "26.0",
      SDKROOT: "iphonesimulator",
      ALWAYS_SEARCH_USER_PATHS: "NO",
      ONLY_ACTIVE_ARCH: "YES",
      SUPPORTED_PLATFORMS: "iphonesimulator",
      CODE_SIGN_IDENTITY: "-",
      CODE_SIGN_STYLE: "Manual",
      DEVELOPMENT_TEAM: "",
      SWIFT_OPTIMIZATION_LEVEL: "-Onone",
    }),
  });
  const products = add({
    isa: "PBXGroup",
    name: "Products",
    children: [product],
    sourceTree: "<group>",
  });
  const root = add({
    isa: "PBXProject",
    attributes: { LastUpgradeCheck: "2650" },
    buildConfigurationList: configuration({}),
    compatibilityVersion: "Xcode 14.0",
    developmentRegion: "en",
    knownRegions: ["en"],
    mainGroup: add({
      isa: "PBXGroup",
      children: [swift, configFile, products],
      sourceTree: "<group>",
    }),
    productRefGroup: products,
    projectDirPath: "",
    projectRoot: "",
    targets: [target],
  });
  const serialize = (value) =>
    Array.isArray(value)
      ? `(${value.map(serialize).join(",")})`
      : value && typeof value === "object"
      ? `{${Object.entries(value)
          .map(([k, v]) => `${JSON.stringify(k)} = ${serialize(v)};`)
          .join("\n")}}`
      : JSON.stringify(value);
  const project = join(stage, "UIQA.xcodeproj");
  const schemes = join(project, "xcshareddata/xcschemes");
  mkdirSync(schemes, { recursive: true });
  writeFileSync(
    join(project, "project.pbxproj"),
    serialize({
      archiveVersion: 1,
      objectVersion: 56,
      classes: {},
      objects,
      rootObject: root,
    }),
  );
  cpSync(fixture, join(stage, "IPadUITests.swift"));
  writeFileSync(join(stage, "qa-config.json"), JSON.stringify(config));
  const ref = `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${target}" BuildableName="IPadUITests.xctest" BlueprintName="IPadUITests" ReferencedContainer="container:UIQA.xcodeproj"/>`;
  writeFileSync(
    join(schemes, "IPadUITests.xcscheme"),
    `<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2650" version="1.3"><BuildAction parallelizeBuildables="NO" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">${ref}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO" parallelizable="NO">${ref}</TestableReference></Testables></TestAction></Scheme>`,
  );
  return project;
}
