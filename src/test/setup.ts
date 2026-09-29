import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";
import deployment from "../../public/deployment.example.json";
import { configureAssetDecimals } from "../domain/assets";
import type { DeploymentConfig } from "../domain/deployment";

beforeEach(() => configureAssetDecimals(deployment as unknown as DeploymentConfig));
