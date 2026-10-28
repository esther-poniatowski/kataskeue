import { readFile, writeFile } from "node:fs/promises";

import * as z from "zod";

import type { PluginRecord } from "../../domain/profile.js";
import { ProfileError } from "../../errors.js";
import type { SettingsAdapter } from "../../ports.js";
import { parseSettingsSource } from "./parseSettingsSource.js";

const dateTargetSchema = z.enum(["scheduledDate", "startDate", "dueDate"]);
const sourceSchema = z
  .object({
    format_version: z.literal(1),
    calendar_source: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .strict(),
    interface: z
      .object({
        first_day: z.number().int().min(0).max(6),
        time_format_24h: z.boolean(),
        weather_hidden: z.boolean(),
        display_timezone: z.string().min(1),
      })
      .strict(),
    tasks: z
      .object({
        backlog_date_target: dateTargetSchema,
        calendar_display_date_target: dateTargetSchema,
        open_edit_modal_after_backlog_drop: z.boolean(),
        task_display_format: z.enum(["standard", "dayPlanner"]),
        include_global_query_in_backlog: z.boolean(),
        backlog_query: z.string(),
      })
      .strict(),
  })
  .strict();

/** Projects the portable Tasks workflow onto the complete 0.13.7 native settings. */
export class FullCalendarRemasteredSettingsAdapter implements SettingsAdapter {
  supports(plugin: PluginRecord): boolean {
    return (
      plugin.id === "full-calendar-remastered" &&
      plugin.bundle.kind === "release" &&
      plugin.bundle.tag === "0.13.7"
    );
  }

  async project(source: string, destination: string): Promise<void> {
    const parsed = sourceSchema.safeParse(
      parseSettingsSource(
        await readFile(source, "utf8"),
        "Full Calendar settings source",
      ),
    );
    if (!parsed.success) {
      throw new ProfileError(
        `invalid Full Calendar settings: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    const input = parsed.data;
    const timeZone = validateTimeZone(input.interface.display_timezone);
    const settings = {
      sidebarConfig: {
        enabled: true,
        width: 290,
        isCollapsed: false,
        collapsedModules: {
          "mini-month": false,
          "up-next": false,
          "task-backlog": false,
          agent: false,
        },
        moduleOrder: ["mini-month", "up-next", "task-backlog", "agent"],
      },
      githubToken: null,
      availabilityGistId: null,
      availabilityExportPath: "",
      availabilityDefaultTimeRange: { startTime: "09:00", endTime: "17:00" },
      useLegacyPlaintextCredentials: false,
      calendarSources: [
        {
          type: "tasks",
          name: input.calendar_source.name,
          color: input.calendar_source.color,
          id: input.calendar_source.id,
        },
      ],
      defaultCalendarId: null,
      firstDay: input.interface.first_day,
      initialView: { desktop: "timeGridWeek", mobile: "timeGrid3Days" },
      timeFormat24h: input.interface.time_format_24h,
      clickToCreateEventFromMonthView: true,
      displayTimezone: timeZone,
      lastSystemTimezone: timeZone,
      enableAdvancedCategorization: false,
      chrono_analyser_config: null,
      categorySettings: [],
      useCustomGoogleClient: false,
      googleClientId: "",
      googleClientSecret: "",
      googleUseCopyPasteAuth: false,
      googleAccounts: [],
      useCustomMicrosoftClient: false,
      microsoftClientId: "",
      microsoftProxyBaseUrl: "",
      microsoftAccounts: [],
      businessHours: {
        enabled: false,
        daysOfWeek: [1, 2, 3, 4, 5],
        startTime: "09:00",
        endTime: "17:00",
      },
      enableBackgroundEvents: true,
      enableReminders: true,
      workspaces: [],
      activeWorkspace: null,
      showEventInStatusBar: false,
      highlightCurrentOrNextEvent: true,
      enableLivePreview: true,
      slotMinTime: "00:00",
      slotMaxTime: "24:00",
      allDaySlot: true,
      timeGridDayHeaderFormat: "day-mmdd",
      weekends: true,
      hiddenDays: [],
      dayMaxEvents: false,
      activityWatch: {
        enabled: false,
        apiUrl: "http://127.0.0.1:5600",
        lastSyncTime: 0,
        autoSyncEnabled: false,
        autoSyncIntervalMins: 10,
        targetCalendarId: "",
        syncStrategy: "auto",
        customDateStart: "",
        customDateEnd: "",
        profiles: [],
      },
      tasksIntegration: {
        backlogDateTarget: input.tasks.backlog_date_target,
        calendarDisplayDateTarget: input.tasks.calendar_display_date_target,
        openEditModalAfterBacklogDrop:
          input.tasks.open_edit_modal_after_backlog_drop,
        taskDisplayFormat: input.tasks.task_display_format,
        includeGlobalQueryInBacklog:
          input.tasks.include_global_query_in_backlog,
        backlogQuery: input.tasks.backlog_query,
      },
      milestones: { counters: {}, unlockedAt: {}, shown: {} },
      enableMonthlyStatsReport: false,
      lastMonthlyMilestonesGeneratedMonth: null,
      lastMonthlyMilestonesCheckDate: null,
      fcrReminderCompanion: {
        enabled: false,
        apiUrl: "http://127.0.0.1:45677",
      },
      apiTokens: {},
      authorizedTokens: {},
      enableLocalServer: false,
      localServerPort: 8540,
      milestoneNotifierDuration: 8000,
      enableDefaultReminder: true,
      defaultReminderMinutes: 10,
      currentVersion: "0.13.7",
      linkedNotesDirectory: "",
      linkedNoteLinkStrategy: "deadline",
      taskBacklogLastProviderId: "",
      caldavTaskInboxLastCalendarId: "",
      weatherCity: "",
      weatherLatitude: null,
      weatherLongitude: null,
      weatherHide: input.interface.weather_hidden,
      weatherInputMode: "city",
      weatherUnit: "C",
      linkedNoteTemplate:
        "# {{title}}\n\n**Date**: {{date}}\n**Time**: {{timeString}}\n**Location**: {{location}}\n**Calendar**: {{calendarName}}\n\n## Description\n{{description}}\n\n## Notes\n- ",
      enableLinkedNoteTemplatesPreset: false,
      linkedNoteTemplatesPresets: [],
      openDailyNoteOnDateClick: false,
      breakTimer: {
        enabled: false,
        intervalMins: 60,
        idleThresholdMins: 30,
        breakDurationSecs: 30,
      },
      agent: {
        enabled: false,
        endpointUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        apiKey: "",
        temperature: 0.2,
        specUrl:
          "https://raw.githubusercontent.com/obsidian-full-calendar-remastered/plugin-full-calendar/main/docs/architecture/api/agent-spec.md",
        maxRetries: 3,
        timeoutMs: 60000,
      },
    };
    await writeFile(destination, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

function validateTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format();
  } catch {
    throw new ProfileError(
      `Full Calendar display time zone is invalid: ${value}`,
    );
  }
  return value;
}
