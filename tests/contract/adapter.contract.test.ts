import { describe, expect, it } from "vitest";
import { UnsupportedOperationError, type PlatformAdapter, type TargetDescriptor } from "../../src/model/index.js";
import { makeDefaultTarget, makeMockNode, MockAdapter } from "../helpers/mock-adapter.js";

function runAdapterContractSuite(
  suiteName: string,
  createAdapter: () => { adapter: PlatformAdapter; target: TargetDescriptor },
): void {
  describe(`Adapter contract: ${suiteName}`, () => {
    it("declares complete info and capabilities", () => {
      const { adapter } = createAdapter();
      expect(adapter.info.kind.length).toBeGreaterThan(0);
      expect(adapter.info.version.length).toBeGreaterThan(0);
      expect(typeof adapter.info.capabilities.discovery).toBe("boolean");
      expect(typeof adapter.info.capabilities.invoke).toBe("boolean");
      expect(typeof adapter.info.capabilities.screenshots).toBe("boolean");
    });

    it("checks availability and opens/disposes a session cleanly", async () => {
      const { adapter, target } = createAdapter();
      const avail = await adapter.checkAvailability(target);
      expect(typeof avail.available).toBe("boolean");

      const session = await adapter.openSession(target);
      try {
        const protections = await session.getSafetyCoverage();
        expect(protections.length).toBeGreaterThan(0);

        const snap = await session.discover();
        expect(snap.location.length).toBeGreaterThan(0);
        expect(snap.nodes.length).toBeGreaterThan(0);

        const first = snap.nodes[0];
        expect(first).toBeDefined();
        if (first !== undefined) {
          expect(first.ref.driverRef.length).toBeGreaterThan(0);
          const resolved = await session.resolveNode(first);
          expect(resolved?.key).toBe(first.key);

          const res = await session.executeAction(first, { type: "invoke" });
          expect(res.attempted).toBe(true);
        }

        const screenshot = await session.captureScreenshot("contract");
        if (adapter.info.capabilities.screenshots) {
          expect(typeof screenshot).toBe("string");
        } else {
          expect(screenshot).toBeNull();
        }
      } finally {
        await session.dispose();
      }
    });

    it("reports unsupported operations explicitly instead of silently simulating them", async () => {
      const { adapter, target } = createAdapter();
      if (adapter.info.capabilities.setValue) {
        return;
      }
      const session = await adapter.openSession(target);
      try {
        const snap = await session.discover();
        const first = snap.nodes[0];
        expect(first).toBeDefined();
        if (first !== undefined) {
          await expect(
            session.executeAction(first, { type: "setValue", value: "abc" }),
          ).rejects.toBeInstanceOf(UnsupportedOperationError);
        }
      } finally {
        await session.dispose();
      }
    });
  });
}

runAdapterContractSuite("Web-capable MockAdapter", () => {
  const safeBtn = makeMockNode({ role: "button", name: "View Details", context: "/home", testId: "view-btn" });
  return {
    adapter: new MockAdapter({
      platform: "web",
      scenario: {
        initialLocation: "/home",
        nodesByLocation: { "/home": [safeBtn] },
      },
    }),
    target: makeDefaultTarget(),
  };
});

runAdapterContractSuite("Constrained Desktop MockAdapter", () => {
  const desktopBtn = makeMockNode({
    role: "AXButton",
    name: "Inspect Item",
    context: "MainWindow",
    elementId: "inspect-btn",
    discoverySources: ["accessibility"],
  });
  return {
    adapter: new MockAdapter({
      platform: "macos",
      capabilities: {
        setValue: false,
        screenshots: false,
        networkObservation: false,
        processMonitoring: true,
        accessibilityEvents: true,
        stateRestore: false,
      },
      scenario: {
        initialLocation: "MainWindow",
        nodesByLocation: { MainWindow: [desktopBtn] },
        protections: [
          { name: "process-scoping", active: true, required: true },
          { name: "http-interception", active: false, required: false, reason: "Native desktop" },
        ],
      },
    }),
    target: makeDefaultTarget({ platform: "macos", processIdentity: "com.example.app" }),
  };
});
