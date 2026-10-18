"use client";
import * as Popover from "@radix-ui/react-popover";
import { HexColorPicker } from "react-colorful";
import { Check, ChevronDown, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  colorChannels,
  colorFromChannels,
  colorPresets,
  recentColors,
  type ColorFormat,
} from "./color";
const recentKey = "ta-accent-colors";

export function ColorPicker({
  value,
  defaultColor,
  onChange,
  disabled,
  id,
  "aria-describedby": describedBy,
}: {
  value: string;
  defaultColor: string;
  onChange: (color: string) => void;
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    try {
      setRecent(
        recentColors(JSON.parse(localStorage.getItem(recentKey) || "[]")),
      );
    } catch {
      /* Storage may be unavailable in private browsing. */
    }
  }, []);
  const changeOpen = (next: boolean) => {
    if (!next) {
      const colors = recentColors([value, ...recent]);
      setRecent(colors);
      try {
        localStorage.setItem(recentKey, JSON.stringify(colors));
      } catch {
        /* Color preferences are optional; template saving remains available. */
      }
    }
    setOpen(next);
  };
  return (
    <Popover.Root open={open && !disabled} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          className="accent-color-trigger"
          aria-label="Accent color"
          aria-describedby={describedBy}
          disabled={disabled}
        >
          <span
            className="accent-color-swatch"
            style={{ backgroundColor: value }}
            aria-hidden="true"
          />
          <span className="accent-color-value">{value.toUpperCase()}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="accent-color-popover"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Accent color picker"
        >
          <ColorControls
            value={value}
            defaultColor={defaultColor}
            onChange={onChange}
            recent={recent}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ColorControls({
  value,
  defaultColor,
  onChange,
  recent,
}: {
  value: string;
  defaultColor: string;
  onChange: (color: string) => void;
  recent: string[];
}) {
  const [format, setFormat] = useState<ColorFormat>("HEX");
  const [inputs, setInputs] = useState(() => colorChannels(value, "HEX"));
  const errorId = useId();
  const invalid = !colorFromChannels(inputs, format);
  const selectColor = (color: string) => {
    onChange(color.toUpperCase());
    setInputs(colorChannels(color, format));
  };
  const labels =
    format === "HEX"
      ? ["HEX"]
      : format === "RGB"
        ? ["R", "G", "B"]
        : ["H", "S", "L"];
  const explanation =
    format === "HEX"
      ? "Enter a 3- or 6-digit HEX color, such as #ABC or #5865F2."
      : format === "RGB"
        ? "Enter whole numbers from 0 to 255 for each RGB channel."
        : "Hue must be 0–360°. Saturation and lightness must be 0–100%.";
  return (
    <>
      <div className="accent-color-heading">
        <strong>Accent color</strong>
        <Popover.Close className="icon-button" aria-label="Close color picker">
          <X size={16} />
        </Popover.Close>
      </div>
      <HexColorPicker
        color={value}
        onChange={selectColor}
        aria-label="Select accent color"
      />
      <div
        className="accent-color-formats"
        role="group"
        aria-label="Color format"
      >
        {(["HEX", "RGB", "HSL"] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={format === item}
            onClick={() => {
              setFormat(item);
              setInputs(colorChannels(value, item));
            }}
          >
            {item}
          </button>
        ))}
      </div>
      <div
        className={`accent-color-inputs ${format === "HEX" ? "hex" : "channels"}`}
      >
        {inputs.map((input, index) => (
          <label key={labels[index]}>
            <span>
              {labels[index]}
              {format === "HSL" ? (index ? " %" : " °") : ""}
            </span>
            <input
              aria-label={
                format === "HEX" ? "HEX color" : `${format} ${labels[index]}`
              }
              aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined}
              value={input}
              maxLength={format === "HEX" ? 16 : 10}
              inputMode={format === "HEX" ? "text" : "decimal"}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                const next = inputs.map((v, i) =>
                  i === index ? e.target.value : v,
                );
                setInputs(next);
                const color = colorFromChannels(next, format);
                if (color) onChange(color);
              }}
              onBlur={() => {
                if (!invalid) setInputs(colorChannels(value, format));
              }}
            />
          </label>
        ))}
      </div>
      {invalid && (
        <p id={errorId} className="accent-color-error" role="alert">
          {explanation} The last valid color stays selected.
        </p>
      )}
      <div className="accent-color-palette">
        <span>Color presets</span>
        <div>
          {colorPresets.map(([name, color]) => (
            <button
              key={color}
              type="button"
              className="accent-color-preset"
              aria-label={`${name} ${color}`}
              title={`${name} · ${color}`}
              onClick={() => selectColor(color)}
              aria-pressed={value.toUpperCase() === color}
              style={{ backgroundColor: color }}
            >
              {value.toUpperCase() === color && (
                <Check size={14} aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      </div>
      {recent.length > 0 && (
        <div className="accent-color-palette">
          <span>Recently used</span>
          <div>
            {recent.map((color) => (
              <button
                key={color}
                type="button"
                className="accent-color-preset"
                title={color}
                aria-label={`Recent color ${color}`}
                onClick={() => selectColor(color)}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>
      )}
      <p className="accent-color-note">
        Preview updates instantly. Save draft to persist changes.
      </p>
      <div className="accent-color-footer">
        <button type="button" onClick={() => selectColor(defaultColor)}>
          Reset
        </button>
        <Popover.Close className="primary" disabled={invalid}>
          Apply
        </Popover.Close>
      </div>
    </>
  );
}
