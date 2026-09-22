// Imports every app model, so `mongoose.models` is complete wherever this is
// imported — the boot index check and `admin doctor`, which would otherwise
// see only the models some route happened to load. Add a new model here.
import mongoose from "mongoose";
import "./ApiToken.js";
import "./Avatar.js";
import "./BusinessProfile.js";
import "./Client.js";
import "./Favorite.js";
import "./ImportBatch.js";
import "./Invoice.js";
import "./Profile.js";
import "./Project.js";
import "./ScheduledJob.js";
import "./Settings.js";
import "./Tag.js";
import "./Task.js";
import "./TimeEntry.js";
import "./WebhookDelivery.js";
import "./WebhookSubscription.js";
import "./WorkspaceMember.js";

/** Every registered app model, sorted by name for stable output. */
export function allModels(): mongoose.Model<unknown>[] {
  return Object.values(mongoose.models)
    .map((model) => model as mongoose.Model<unknown>)
    .sort((a, b) => a.modelName.localeCompare(b.modelName));
}
