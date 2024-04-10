import { LitElement, html } from "lit";
import { property, state } from "lit/decorators.js";
import { hasTemplate } from "card-tools/src/templates";
import { bind_template, unbind_template } from "./templates";
import { filter_entity } from "./filter";
import { get_sorter } from "./sort";
import {
  AutoEntitiesConfig,
  EntityList,
  HuiErrorCard,
  LovelaceCard,
  LovelaceRowConfig,
  FilterConfig,
  FilterType,
} from "./types";
import pjson from "../package.json";
import "./editor/auto-entities-editor";
import { compare_deep, getAreas, getDevices, getEntities } from "./helpers";

window.queueMicrotask =
  window.queueMicrotask || ((handler) => window.setTimeout(handler, 1));

const HIDDEN_TYPES = ["section", "divider"];

class AutoEntities extends LitElement {
  @property() _config: AutoEntitiesConfig;
  @property() hass: any;
  @property() card: LovelaceCard;
  @property() else?: LovelaceCard;
  @property() _template: string[];
  @state() empty = false;

  editMode?: boolean;

  _entities: EntityList;
  _cardConfig;
  _cardBuilt?: Promise<void>;
  _cardBuiltResolve?;
  _throttle = {
    timer: undefined as number | undefined,
    count: 0,
  };
  _cache: Record<string, { updated: string; filters: FilterConfig[] }> = {};

  static getConfigElement() {
    return document.createElement("auto-entities-editor");
  }
  static getStubConfig() {
    return {
      card: {
        type: "entities",
      },
      filter: {
        include: [],
        exclude: [],
      },
    };
  }

  setConfig(config: AutoEntitiesConfig) {
    if (!config) {
      throw new Error("No configuration.");
    }
    if (!config.card?.type) {
      throw new Error("No card type specified.");
    }
    if (!config.filter && !config.entities) {
      throw new Error("No filters specified.");
    }
    config = JSON.parse(JSON.stringify(config));
    this._config = config;
    this._cache = {};

    if (
      this._config.filter?.template &&
      hasTemplate(this._config.filter.template)
    ) {
      bind_template(this._renderer, this._config.filter.template, { config });
    }

    this._cardBuilt = new Promise(
      (resolve) => (this._cardBuiltResolve = resolve)
    );

    queueMicrotask(() => this.build_else());
    queueMicrotask(() => this.update_all());
  }

  _renderer = (tpl) => {
    if (typeof tpl === "string") {
      this._template = tpl.split(/[\s,]+/);
    } else {
      this._template = tpl;
    }
  };

  connectedCallback() {
    super.connectedCallback();
    if (
      this._config?.filter?.template &&
      hasTemplate(this._config.filter.template)
    ) {
      bind_template(this._renderer, this._config.filter.template, {
        config: this._config,
      });
    }
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    unbind_template(this._renderer);
  }

  async update_all(debounce = true) {
    if (this.card) this.card.hass = this.hass;
    if (this.else) this.else.hass = this.hass;

    // Allow first updates to go through immediately
    // before starting to debounce
    if (debounce && this.hass && this._throttle.count++ > 3) {
      if (this._throttle.timer) return;
      this._throttle.timer = setTimeout(
        () => {
          this._throttle.timer = undefined;
          this.update_all(false);
        },
        (this._config.throttle ?? 0.5) * 1000
      );
      return;
    }

    const entities = await this.update_entities();
    this.update_card(entities);
  }

  async build_else() {
    if (this._config.else === undefined) return;
    const helpers = await (window as any).loadCardHelpers();
    this.else = await helpers.createCardElement(this._config.else);
    this.else.hass = this.hass;
  }

  async update_card(entities: EntityList) {
    if (
      !this.editMode &&
      this._entities &&
      compare_deep(entities, this._entities) &&
      compare_deep(this._cardConfig, this._config.card)
    )
      return;
    const newType = this._cardConfig?.type !== this._config.card.type;
    this._entities = entities;
    this._cardConfig = JSON.parse(JSON.stringify(this._config.card));
    const cardConfig = {
      [this._config.card_param || "entities"]: entities,
      ...this._config.card,
    };
    if (!this.card || newType) {
      const helpers = await (window as any).loadCardHelpers();

      // Replace console.error in order to catch errors from cards which don't like to be given an empty entities list
      (console as any).oldError = (console as any).oldError || [];
      const _consoleError = console.error;
      (console as any).oldError.push(_consoleError);
      console.error = (...args) => {
        if (args.length === 3 && args[2].message) {
          if (
            args[2].message.startsWith?.("Entities") || // Logbook-card
            args[2].message.startsWith?.("Either entities") || // Map card
            args[2].message.endsWith?.("entity") // History-graph card
          ) {
            return;
          }
        }
        _consoleError(...args);
      };

      try {
        this.card = await helpers.createCardElement(cardConfig);

        if (this.card.localName === "hui-error-card") {
          const errorCard = this.card as HuiErrorCard;
          await customElements.whenDefined("hui-error-card");
          let ctr = 10;
          while (!errorCard._config && ctr) {
            await new Promise((resolve) => window.setTimeout(resolve, 100));
            ctr--;
          }
          if (
            errorCard._config?.error?.startsWith?.("Entities") ||
            errorCard._config?.error?.startsWith?.("Either entities") ||
            errorCard._config?.error?.endsWith?.("entity")
          ) {
            this.card = undefined;
            this._entities = undefined;
            this._cardConfig = undefined;
            this._cardBuiltResolve?.();
            return;
          }
        }
      } finally {
        console.error = (console as any).oldError.pop();
      }
    } else {
      this.card.setConfig(cardConfig);
    }

    this._cardBuiltResolve?.();
    this.card.hass = this.hass;

    this.empty =
      entities.length === 0 ||
      entities.every((e) => HIDDEN_TYPES.includes(e.type));
    let hide =
      this.empty &&
      this._config.show_empty === false &&
      this._config.else === undefined;
    this.style.display = hide ? "none" : null;
    this.style.margin = hide ? "0" : null;
    let parent = this.parentElement;
    if (parent && this.editMode) {
      parent = parent.parentElement;
      hide = false;
    }
    if (parent && parent.classList.contains("card")) {
      parent.style.display = hide ? "none" : null;
    }
    if ((this.card as any).requestUpdate) {
      (this.card as any).requestUpdate();
      await this.updateComplete;
    }
  }

  async match(entity: string) {
    const filters = await this._match(entity, "include");
    if (filters.length) {
      const exclude = await this._match(entity, "exclude");
      if (!exclude.length) return filters;
    }
    return [];
  }

  async _match(entity: string, type: FilterType) {
    const ret: FilterConfig[] = [];

    if (!this._config.filter?.[type]) return ret;

    for (const filter of this._config.filter?.[type] ?? []) {
      if (filter.type) continue;
      if (await filter_entity(this.hass, filter, entity)) {
        ret.push(filter);
        if (this._config.unique == "entity" || type == "exclude") break;
      }
    }
    return ret;
  }

  async update_entities() {
    const format = (entity: LovelaceRowConfig | string): LovelaceRowConfig => {
      if (!entity) return null;
      return typeof entity === "string" ? { entity: entity.trim() } : entity;
    };

    let entities: EntityList = [...(this._config?.entities?.map(format) || [])];

    const merge_options = () =>
      entities.map((e) => ({ ...this._config.card_options, ...e }));

    if (!this.hass) {
      return merge_options();
    }

    if (this._template) {
      entities = entities.concat(this._template.map(format));
    }

    // Remove entities that are excluded
    entities = (
      await Promise.all(
        entities.map(async (e) =>
          e && !(await this._match(e.entity, "exclude")).length ? e : undefined
        )
      )
    ).filter(Boolean);

    entities = merge_options();

    if (this._config.filter?.include) {
      const all_entities = Object.keys(this.hass.states).map(format);

      const entities_by_filter: Map<FilterConfig, EntityList> = new Map();

      for (const entity of all_entities) {
        if (!entity) continue;
        let filters: FilterConfig[] = [];
        const updated = this.hass.states[entity.entity].last_updated;
        const cached = this._cache[entity.entity];

        if (cached && cached.updated === updated) {
          filters = cached.filters;
        } else {
          filters = await this.match(entity.entity);
          this._cache[entity.entity] = { updated, filters };
        }

        for (const filter of filters) {
          if (!entities_by_filter.has(filter))
            entities_by_filter.set(filter, []);
          entities_by_filter.get(filter).push(entity);
        }
      }

      for (const filter of this._config.filter.include) {
        if (filter.type) {
          entities.push(filter);
          continue;
        }
        let add: EntityList = [];
        for (const entity of entities_by_filter.get(filter) || []) {
          add.push(
            JSON.parse(
              JSON.stringify({
                ...this._config.card_options,
                ...entity,
                ...filter.options,
              }).replace(/this.entity_id/g, entity.entity)
            )
          );
        }

        if (filter.sort) {
          await getEntities(this.hass);
          await getDevices(this.hass);
          await getAreas(this.hass);
          add = add.sort(get_sorter(this.hass, filter.sort));
          if (filter.sort.count ?? filter.sort.first) {
            const start = filter.sort.first ?? 0;
            add = add.slice(start, start + (filter.sort.count ?? Infinity));
          }
        }
        entities = entities.concat(add);
      }
    }

    if (this._config.sort) {
      entities = entities.sort(get_sorter(this.hass, this._config.sort));
      if (this._config.sort.count) {
        const start = this._config.sort.first ?? 0;
        entities = entities.slice(start, start + this._config.sort.count);
      }
    }

    if (this._config.unique !== "entity" && this._config.unique) {
      let newEntities: EntityList = [];
      for (const e of entities) {
        if (newEntities.some((i) => compare_deep(i, e))) continue;
        newEntities.push(e);
      }
      entities = newEntities;
    }

    return entities;
  }

  async updated(changedProperties) {
    if (
      changedProperties.has("_template") ||
      (changedProperties.has("hass") && this.hass)
    ) {
      queueMicrotask(() => this.update_all());
    }
  }

  createRenderRoot() {
    return this;
  }
  render() {
    return html`${this.empty &&
    (this._config.show_empty === false || this._config.else)
      ? this.else
      : this.card}`;
  }

  async getCardSize() {
    let len = 0;
    await this._cardBuilt;
    if (this.card && this.card.getCardSize) len = await this.card.getCardSize();
    if (len === 1 && this._entities?.length) len = this._entities.length;
    if (len === 0 && this._config.filter?.include)
      len = Object.keys(this._config.filter.include).length;
    return len || 5;
  }
}

if (!customElements.get("auto-entities")) {
  customElements.define("auto-entities", AutoEntities);
  console.groupCollapsed(
    `%cAUTO-ENTITIES ${pjson.version} IS INSTALLED`,
    "color: green; font-weight: bold"
  );
  console.log(
    "Readme:",
    "https://github.com/thomasloven/lovelace-auto-entities"
  );
  console.groupEnd();
}
