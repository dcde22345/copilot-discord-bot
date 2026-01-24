using CopilotDiscordBot;
using CopilotDiscordBot.Data;
using CopilotDiscordBot.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptions<BotOptions>().Bind(builder.Configuration.GetSection("Bot"));

builder.Services.AddSingleton<SqliteSessionStore>();
builder.Services.AddSingleton<SessionRuntimeManager>();
builder.Services.AddHostedService<DiscordBotHostedService>();

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { status = "ok", utc = DateTimeOffset.UtcNow }));
app.MapGet("/", () => Results.Text("Copilot Discord Bot is running. See /health"));

app.Run();
