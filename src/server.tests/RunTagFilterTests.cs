using PipelineLaunchpad.Server.Services;

namespace PipelineLaunchpad.Server.Tests;

public class RunTagFilterTests
{
    [Fact]
    public void An_empty_filter_matches_every_run_and_fetches_only_what_is_shown()
    {
        var f = RunTagFilter.From(null, null);
        Assert.True(f.IsEmpty);
        Assert.True(f.Matches([]));
        Assert.True(f.Matches(["prod"]));
        Assert.Equal(4, f.FetchSize(4));
        Assert.Equal("", f.QuerySuffix);
    }

    [Fact]
    public void Include_is_all_of()
    {
        var f = RunTagFilter.From(["prod", "release"], null);
        Assert.True(f.Matches(["release", "prod", "extra"]));
        Assert.False(f.Matches(["prod"]));
        Assert.False(f.Matches([]));
    }

    [Fact]
    public void Exclude_is_any_of()
    {
        var f = RunTagFilter.From(null, ["🚀 launchpad", "nightly"]);
        Assert.True(f.Matches([]));
        Assert.True(f.Matches(["prod"]));
        Assert.False(f.Matches(["nightly"]));
        Assert.False(f.Matches(["prod", "🚀 launchpad"]));
    }

    [Fact]
    public void Tags_compare_case_insensitively_as_Azure_DevOps_does()
    {
        var f = RunTagFilter.From(["Prod"], ["NIGHTLY"]);
        Assert.True(f.Matches(["prod"]));
        Assert.False(f.Matches(["prod", "nightly"]));
    }

    [Fact]
    public void Blank_and_duplicate_tags_are_dropped()
    {
        var f = RunTagFilter.From(["  prod ", "", "PROD", "   "], [" "]);
        Assert.Equal(["prod"], f.Include);
        Assert.Empty(f.Exclude);
    }

    [Fact]
    public void Include_goes_to_Azure_DevOps_escaped_and_comma_joined()
    {
        var f = RunTagFilter.From(["prod", "🚀 launchpad"], null);
        Assert.Equal("&tagFilters=" + Uri.EscapeDataString("prod,🚀 launchpad"), f.QuerySuffix);
        Assert.Equal(4, f.FetchSize(4));
    }

    [Fact]
    public void A_tag_containing_a_comma_is_filtered_here_rather_than_split_by_Azure_DevOps()
    {
        var f = RunTagFilter.From(["a,b", "prod"], null);
        Assert.Equal("&tagFilters=prod", f.QuerySuffix);
        Assert.False(f.Matches(["prod", "a", "b"]));
        Assert.True(f.Matches(["prod", "a,b"]));
    }

    [Fact]
    public void Excluding_over_fetches_so_the_card_still_fills_but_never_past_the_cap()
    {
        var f = RunTagFilter.From(null, ["nightly"]);
        Assert.Equal(4 * RunTagFilter.ExcludeOverfetch, f.FetchSize(4));
        Assert.Equal(RunTagFilter.MaxFetch, f.FetchSize(50));
    }
}
