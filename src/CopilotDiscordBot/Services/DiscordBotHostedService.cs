using CopilotDiscordBot.Data;
using CopilotDiscordBot.Utils;
using Discord;
using Discord.WebSocket;
using Microsoft.Extensions.Options;

namespace CopilotDiscordBot.Services;

public sealed class DiscordBotHostedService : BackgroundService
{
    private readonly ILogger<DiscordBotHostedService> _logger;
    private readonly BotOptions _options;
    private readonly SqliteSessionStore _store;
    private readonly SessionRuntimeManager _runtimeManager;

    private DiscordSocketClient? _client;
    private DiscordCommandRouter? _router;

    public DiscordBotHostedService(
        ILogger<DiscordBotHostedService> logger,
        IOptions<BotOptions> options,
        SqliteSessionStore store,
        SessionRuntimeManager runtimeManager)
    {
        _logger = logger;
        _options = options.Value;
        _store = store;
        _runtimeManager = runtimeManager;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (string.IsNullOrWhiteSpace(_options.DiscordBotToken))
        {
            _logger.LogCritical("Bot:DiscordBotToken is empty. Discord bot will not start. Set the token in appsettings.json or user-secrets/environment variables.");
            try
            {
                await Task.Delay(Timeout.Infinite, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                // expected
            }
            return;
        }

        if (!Directory.Exists(_options.ReposRoot))
        {
            _logger.LogWarning("ReposRoot does not exist: {ReposRoot}", _options.ReposRoot);
        }

        var config = new DiscordSocketConfig
        {
            GatewayIntents = GatewayIntents.Guilds | GatewayIntents.GuildMessages | GatewayIntents.MessageContent | GatewayIntents.GuildMessageReactions,
            LogGatewayIntentWarnings = true,
            AlwaysDownloadUsers = false
        };

        _client = new DiscordSocketClient(config);
        _client.Log += msg =>
        {
            _logger.Log(MapLogSeverity(msg.Severity), msg.Exception, "Discord: {Message}", msg.Message);
            return Task.CompletedTask;
        };

        _router = new DiscordCommandRouter(_logger, _options, _store, _runtimeManager, _client);

        _client.MessageReceived += message =>
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    if (_router is null) return;
                    await _router.HandleMessageAsync(message);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Message handler failed");
                }
            });

            return Task.CompletedTask;
        };

        _client.ReactionAdded += (cachedMessage, cachedChannel, reaction) =>
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    if (_router is null) return;
                    await _router.HandleReactionAsync(cachedMessage, cachedChannel, reaction);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Reaction handler failed");
                }
            });

            return Task.CompletedTask;
        };

        try
        {
            await _client.LoginAsync(TokenType.Bot, _options.DiscordBotToken);
            await _client.StartAsync();
        }
        catch (Exception ex)
        {
            _logger.LogCritical(ex, "Failed to login/start Discord client. Check token and bot permissions.");
            try
            {
                await Task.Delay(Timeout.Infinite, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                // expected
            }
            return;
        }

        _logger.LogInformation("Discord bot started");

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // expected
        }

        _logger.LogInformation("Stopping Discord bot...");

        if (_client != null)
        {
            await _client.StopAsync();
            await _client.LogoutAsync();
        }

        await _runtimeManager.DisposeAllAsync();
    }

    private static LogLevel MapLogSeverity(LogSeverity severity) => severity switch
    {
        LogSeverity.Critical => LogLevel.Critical,
        LogSeverity.Error => LogLevel.Error,
        LogSeverity.Warning => LogLevel.Warning,
        LogSeverity.Info => LogLevel.Information,
        LogSeverity.Verbose => LogLevel.Debug,
        LogSeverity.Debug => LogLevel.Debug,
        _ => LogLevel.Information
    };
}
